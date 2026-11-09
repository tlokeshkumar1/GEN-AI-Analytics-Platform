"""Optional custom Python charts execute in a resource-limited, credential-free OCI container."""
import io
import json
import os
import re
import subprocess
import tempfile
import threading
import uuid
from pathlib import Path

from fastapi import HTTPException


def container_command(image, source, name):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9./:_-]*", image):
        raise ValueError("Configure a valid chart worker image name")
    wrapper = (
        "import contextlib,os,runpy,sys; "
        "out=sys.stdout.buffer; "
        "\nwith open(os.devnull,'w') as sink, contextlib.redirect_stdout(sink): runpy.run_path('/work/chart.py',run_name='__main__')"
        "\nwith open('/output/chart.png','rb') as image: data=image.read(8388609)"
        "\nif len(data)>8388608 or not data.startswith(bytes([137,80,78,71,13,10,26,10])): raise ValueError('Invalid chart output')"
        "\nout.write(data)"
    )
    return ["docker", "run", "--rm", "--name", name, "--network=none", "--memory=256m", "--cpus=1", "--pids-limit=64",
            "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only", "--user=65534:65534",
            "--tmpfs=/tmp:rw,noexec,nosuid,size=64m", "--tmpfs=/output:rw,noexec,nosuid,size=16m,mode=1777",
            "--mount", f"type=bind,src={source},dst=/work,readonly", "--env=MPLCONFIGDIR=/tmp/matplotlib",
            image, "python", "-I", "-B", "-c", wrapper]


def execute_isolated(code, rows, image):
    with tempfile.TemporaryDirectory(prefix="analytics-chart-") as folder:
        source = Path(folder)
        source.chmod(0o755)
        (source / "chart.py").write_text(code, encoding="utf-8")
        (source / "data.json").write_text(json.dumps(rows, default=str), encoding="utf-8")
        name = "analytics-chart-" + uuid.uuid4().hex
        process = None
        output = bytearray()
        oversized = threading.Event()
        try:
            process = subprocess.Popen(container_command(image, str(source.resolve()), name), stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
            def read_output():
                while True:
                    block = process.stdout.read(65536)
                    if not block:
                        return
                    if len(output) + len(block) > 8388608:
                        oversized.set()
                        process.kill()
                        return
                    output.extend(block)
            reader = threading.Thread(target=read_output, daemon=True)
            reader.start()
            process.wait(timeout=65)
            reader.join(timeout=2)
            if process.returncode or oversized.is_set() or not output.startswith(b"\x89PNG\r\n\x1a\n"):
                raise HTTPException(502, "The isolated chart worker did not produce a valid PNG. Review the request and retry.")
            return bytes(output)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            raise HTTPException(503, "The chart worker is unavailable or exceeded its execution timeout.") from None
        finally:
            if process is not None:
                if process.poll() is None:
                    process.kill(); process.wait(timeout=5)
                if process.stdout:
                    process.stdout.close()
                subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)


def generate_custom_chart(payload, datasets, progress):
    from api.models.execution_context import DatasetSelection, ExecutionContext, current_identity, current_selection
    from api.platform.semantic import semantic_registry
    from api.services.analytics_engine import analytics_engine
    from api.services.ai_core_service import ai_core_service
    from api.platform.storage import ArtifactStore
    image = os.getenv("PLATFORM_CHART_IMAGE")
    if not image:
        raise HTTPException(503, "Configure an isolated chart worker image before using custom Python charts.")
    entry = datasets._entry(datasets._catalog(), payload["dataset_id"])
    context = ExecutionContext(**payload["context"])
    if context.user_id != current_identity.get()["user_id"]:
        raise HTTPException(403, "Chart job identity does not match its data context.")
    snapshot = datasets._snapshot(entry, context.version)
    semantic_registry.get(entry, context.version, context.semantic_revision, approved=True)
    token = current_selection.set(DatasetSelection(context, entry, snapshot))
    try:
        result = analytics_engine.execute(payload["query_plan"])
        if not result.success or not result.data:
            raise HTTPException(422, result.error or "There are no matching values to chart.")
        progress("code_generation")
        prompt = ("Return only Python code to render a chart using matplotlib Agg, pandas, and seaborn. "
                  "Read the precomputed results from /work/data.json. Preserve their labels and values. Do not fetch data, read other files, "
                  "recalculate business totals, or invent values. Save the PNG only to /output/chart.png. "
                  "Request: " + payload["prompt"] + "\nComputed result fields: " + json.dumps(list(result.data[0])))
        raw = ai_core_service.generate_aicore_completion(prompt)
        if not raw:
            raise HTTPException(503, "SAP AI Core code generation is unavailable. Check its deployment and credentials.")
        code = re.sub(r"```(?:python)?\s*|```", "", raw, flags=re.I).strip()
        progress("isolated_execution")
        png = execute_isolated(code, result.data, image)
        objects = datasets.repository.objects if datasets.repository else ArtifactStore()
        return {"image_key": objects.put(png), "context": context.model_dump(), "query_plan": payload["query_plan"],
                "execution_backend": "isolated_python", "code_generation_provider": "SAP AI Core",
                "records_matched": result.records_matched}
    finally:
        current_selection.reset(token)
