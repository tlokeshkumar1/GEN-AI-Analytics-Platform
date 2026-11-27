"""Validate SAP CF deployment contracts and, optionally, a built MTA archive.

This checks packaging only; it never authenticates, deploys, or calls SAP services.
"""

import argparse
import io
import json
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

import yaml

ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def private_configuration(name):
    return any(
        part == ".env"
        or part.startswith(".env.")
        or part == "default-env.json"
        or part.endswith(".mtaext")
        for part in PurePosixPath(name).parts
    )


def validate_descriptor(descriptor):
    modules = {m["name"]: m for m in descriptor["modules"]}
    prefix = descriptor["ID"]
    api = modules[f"{prefix}-api"]
    worker = modules[f"{prefix}-worker"]
    router = modules[f"{prefix}-router"]
    require(
        api["parameters"]["buildpack"] == "python_buildpack",
        "API must use the Python buildpack",
    )
    require(
        api["parameters"]["health-check-type"] == "http",
        "API needs an HTTP health check",
    )
    require(
        worker["parameters"]["command"] == "python -m api.worker",
        "Worker must start independently",
    )
    require(
        worker["parameters"].get("no-route") is True, "Worker must have no public route"
    )
    require(
        worker["parameters"]["health-check-type"] == "process",
        "Worker needs a process health check",
    )
    for module in (api, worker):
        props = module["properties"]
        require(
            props["APP_ENV"] == "production",
            "CF runtime must use production authentication",
        )
        require(
            props["PLATFORM_METADATA_BACKEND"] == "hana", "CF metadata must be durable"
        )
        require(
            props["PLATFORM_OBJECT_BACKEND"] == "hana", "CF objects must be durable"
        )
        bindings = {r["name"] for r in module["requires"]}
        require(f"{prefix}-hdi-container" in bindings, "HANA binding missing")
        require(f"{prefix}-xsuaa" in bindings, "XSUAA binding missing")
    destinations = [r for r in router["requires"] if r.get("group") == "destinations"]
    require(
        any(
            r["properties"].get("name") == "backend-api"
            and r["properties"].get("forwardAuthToken") is True
            for r in destinations
        ),
        "Approuter must forward authentication to the API",
    )
    return modules


def validate_archive(path):
    with ZipFile(path) as archive:
        require(
            not any(private_configuration(name) for name in archive.namelist()),
            "Private configuration included in MTA archive",
        )
        descriptor = yaml.safe_load(archive.read("META-INF/mtad.yaml"))
        modules = validate_descriptor(descriptor)
        prefix = descriptor["ID"]
        for suffix in ("api", "worker", "router"):
            module = modules[f"{prefix}-{suffix}"]
            with ZipFile(
                io.BytesIO(archive.read(f"{module['path']}/data.zip"))
            ) as payload:
                names = set(payload.namelist())
                for name in names:
                    require(
                        not private_configuration(name),
                        f"Private configuration packaged in {suffix}: {name}",
                    )
                if suffix == "router":
                    require(
                        "resources/index.html" in names,
                        "Built frontend index missing from approuter",
                    )
                    require(
                        any(
                            n.startswith("resources/assets/") and n.endswith(".js")
                            for n in names
                        ),
                        "Built frontend JavaScript missing",
                    )
                    require("xs-app.json" in names, "SAP routing configuration missing")
                else:
                    require(
                        "api/app.py" in names and "api/worker.py" in names,
                        "Python entry points missing",
                    )
                    require(
                        "requirements.txt" in names and "Procfile" in names,
                        "Python buildpack inputs missing",
                    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path)
    args = parser.parse_args()
    validate_descriptor(yaml.safe_load((ROOT / "mta.yaml").read_text(encoding="utf-8")))
    command = (ROOT / "backend/Procfile").read_text().strip()
    require(
        "api.app:app" in command
        and "--host 0.0.0.0" in command
        and "--port $PORT" in command,
        "API must listen on the CF-assigned PORT",
    )
    routes = json.loads((ROOT / "router/xs-app.json").read_text())
    api_route = next(
        r for r in routes["routes"] if r.get("destination") == "backend-api"
    )
    require(
        api_route["authenticationType"] == "xsuaa"
        and api_route.get("csrfProtection") is True,
        "API routes must enforce SAP authentication and CSRF",
    )
    if args.archive:
        validate_archive(args.archive)
    print(
        "SAP Cloud Foundry deployment contracts passed (offline; no live deployment)."
    )


if __name__ == "__main__":
    main()
