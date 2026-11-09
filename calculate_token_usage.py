#!/usr/bin/env python3
"""
calculate_token_usage.py
========================
Real-Time Parallel Token Monitor & Usage Calculator for NVIDIA NIM API.

Run this in a separate terminal while you interact with the application:
    cd backend/api && venv\\Scripts\\activate && python calculate_token_usage.py
OR from the project root:
    python calculate_token_usage.py

It tracks and displays token consumption for EVERY request in real time.
"""

import os
import sys
import json
import time
import re
import argparse
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, List, Optional

# Ensure UTF-8 output on Windows terminal
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    try:
        import msvcrt
        WINDOWS_KEYBOARD = True
    except ImportError:
        WINDOWS_KEYBOARD = False
else:
    WINDOWS_KEYBOARD = False

try:
    import requests
except ImportError:
    print("[ERROR] 'requests' package is required. Install it using: pip install requests")
    sys.exit(1)


# ── Project Root & Ledger Resolution ─────────────────────────────────────────

def find_project_root() -> Path:
    """Find the project root containing .env, whether invoked from root or backend/api."""
    current = Path(__file__).resolve().parent
    for p in [current, current.parent, current.parent.parent]:
        if (p / ".env").exists() and (p / "backend").exists():
            return p
    return current


ROOT_DIR = find_project_root()
LEDGER_FILE = ROOT_DIR / ".token_usage.jsonl"


# ── Environment & Config Loader ──────────────────────────────────────────────

def load_env_variables() -> Dict[str, str]:
    """Load configuration from .env file or environment."""
    env_vars = {}
    env_path = ROOT_DIR / ".env"

    if env_path.exists():
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, val = line.split("=", 1)
                    key = key.strip()
                    val = val.strip().strip("'\"")
                    env_vars[key] = val
        except Exception:
            pass

    for k in ["NVIDIA_API_KEY", "NVIDIA_LLM_MODEL", "NVIDIA_LLM_URL", "NVIDIA_EMBEDDING_MODEL"]:
        if k in os.environ and k not in env_vars:
            env_vars[k] = os.environ[k]

    return env_vars


# ── Token Counter (Heuristic approximation) ──────────────────────────────────

def estimate_tokens(text: str) -> int:
    """Estimates token count (~3.8 characters or ~0.75 words per token)."""
    if not text:
        return 0
    tokens = re.findall(r"\w+|[^\w\s]", str(text), re.UNICODE)
    return max(1, int(len(tokens) * 1.15))


# ── Token Ledger Recording & Loading ─────────────────────────────────────────

def record_token_usage(
    source: str,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    latency_ms: float = 0.0,
    status: str = "success"
) -> None:
    """
    Appends a token transaction record to .token_usage.jsonl.
    Called both by backend services (on every chat/query) and by this monitor.
    """
    total = int(prompt_tokens) + int(completion_tokens)
    entry = {
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "time_short": datetime.now().strftime("%H:%M:%S"),
        "source": str(source),
        "model": str(model or "meta/llama-3.2-11b"),
        "prompt_tokens": int(prompt_tokens),
        "completion_tokens": int(completion_tokens),
        "total_tokens": int(total),
        "latency_ms": round(float(latency_ms), 1),
        "status": str(status)
    }

    try:
        with open(LEDGER_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def load_token_history() -> Dict[str, Any]:
    """Reads all records from .token_usage.jsonl and calculates aggregated metrics."""
    records: List[Dict[str, Any]] = []

    if LEDGER_FILE.exists():
        try:
            with open(LEDGER_FILE, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        records.append(json.loads(line))
                    except Exception:
                        pass
        except Exception:
            pass

    total_prompt = sum(r.get("prompt_tokens", 0) for r in records)
    total_completion = sum(r.get("completion_tokens", 0) for r in records)
    total_tokens = sum(r.get("total_tokens", 0) for r in records)

    by_source: Dict[str, Dict[str, int]] = {}
    for r in records:
        src = r.get("source", "Other")
        if src not in by_source:
            by_source[src] = {"calls": 0, "tokens": 0}
        by_source[src]["calls"] += 1
        by_source[src]["tokens"] += r.get("total_tokens", 0)

    return {
        "count": len(records),
        "total_prompt": total_prompt,
        "total_completion": total_completion,
        "total_tokens": total_tokens,
        "by_source": by_source,
        "records": records
    }


def clear_ledger() -> None:
    """Resets the token ledger file."""
    try:
        if LEDGER_FILE.exists():
            LEDGER_FILE.unlink()
    except Exception:
        pass


# ── Live NVIDIA NIM API Caller ───────────────────────────────────────────────

def test_live_api_call(
    api_key: str,
    prompt: str = "Provide a 1-sentence executive summary of business gross margin.",
    model: str = "meta/llama-3.2-11b-vision-instruct",
    api_url: str = "https://integrate.api.nvidia.com/v1/chat/completions",
    record: bool = True
) -> Dict[str, Any]:
    """Sends a live test request to NVIDIA NIM and records the exact tokens."""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json"
    }
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a concise enterprise analytics assistant."},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.2,
        "max_tokens": 150,
        "stream": False
    }

    t0 = time.time()
    try:
        res = requests.post(api_url, headers=headers, json=payload, timeout=25)
        latency_ms = round((time.time() - t0) * 1000, 2)

        if res.status_code == 200:
            data = res.json()
            usage = data.get("usage", {})
            p_tok = usage.get("prompt_tokens", estimate_tokens(prompt))
            c_tok = usage.get("completion_tokens", 50)
            content = data.get("choices", [{}])[0].get("message", {}).get("content", "")

            if record:
                record_token_usage("Live Test", model, p_tok, c_tok, latency_ms, status="success")

            return {
                "success": True,
                "status_code": res.status_code,
                "latency_ms": latency_ms,
                "model": model,
                "prompt_tokens": p_tok,
                "completion_tokens": c_tok,
                "total_tokens": p_tok + c_tok,
                "preview": content.strip().replace("\n", " ")[:90] + "..."
            }
        else:
            if record:
                record_token_usage("Live Test", model, 0, 0, latency_ms, status=f"error_{res.status_code}")
            return {
                "success": False,
                "status_code": res.status_code,
                "latency_ms": latency_ms,
                "error": res.text[:120]
            }
    except Exception as e:
        latency_ms = round((time.time() - t0) * 1000, 2)
        if record:
            record_token_usage("Live Test", model, 0, 0, latency_ms, status="exception")
        return {"success": False, "status_code": 0, "latency_ms": latency_ms, "error": str(e)}


# ── Dataset Token Calculation ────────────────────────────────────────────────

def get_dataset_tokens() -> Dict[str, Any]:
    """Calculates dataset embedding token footprint from snapshot."""
    snapshot_path = ROOT_DIR / "backend" / "preprocessing" / "output" / "SAC_Sales_Preprocessed" / ".version_1.json"
    if not snapshot_path.exists():
        candidates = list(ROOT_DIR.glob("backend/preprocessing/output/*/.version_*.json"))
        if candidates:
            snapshot_path = candidates[0]

    if snapshot_path.exists():
        try:
            with open(snapshot_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            chunks = data.get("chunks", [])
            total_tokens = sum(estimate_tokens(c) for c in chunks)
            return {
                "found": True,
                "rows": len(data.get("rows", [])),
                "chunks": len(chunks),
                "tokens": total_tokens
            }
        except Exception as e:
            return {"found": False, "error": str(e)}

    return {"found": False, "error": "No snapshot file"}


# ── Dashboard Renderer ───────────────────────────────────────────────────────

def mask_key(key: str) -> str:
    if not key or len(key) < 12:
        return "[NOT CONFIGURED]"
    return f"{key[:8]}...{key[-5:]}"


def render_dashboard(
    env_vars: Dict[str, str],
    history: Dict[str, Any],
    start_time: float,
    last_status: Optional[str] = None
) -> None:
    """Renders the live parallel monitoring dashboard."""
    if sys.platform == "win32":
        os.system("cls")
    else:
        print("\033[H\033[J", end="")

    uptime_sec = int(time.time() - start_time)
    uptime_str = f"{uptime_sec // 3600:02d}:{(uptime_sec % 3600) // 60:02d}:{uptime_sec % 60:02d}"

    key = env_vars.get("NVIDIA_API_KEY", "")
    model = env_vars.get("NVIDIA_LLM_MODEL", "meta/llama-3.2-11b-vision-instruct")
    estimated_credits_remaining = max(0, 1000 - history["count"])

    w = 78
    print("+" + "-" * w + "+")
    print(f"|  ⚡ LIVE TOKEN USAGE MONITOR                   Uptime: {uptime_str}  [PARALLEL MODE] |")
    print("+" + "-" * w + "+")
    print(f"|  API Key:  {mask_key(key):<22} Model: {model[:36]:<36} |")
    print(f"|  Ledger:   {str(LEDGER_FILE.name):<22} Time:  {datetime.now().strftime('%Y-%m-%d %H:%M:%S'):<36} |")
    print("+" + "-" * w + "+")

    # Metrics Summary Cards
    print("|                                                                              |")
    print(f"|   TOTAL REQUESTS        PROMPT TOKENS      COMPLETION TOKENS    TOTAL TOKENS |")
    print(f"|   {history['count']:<21,} {history['total_prompt']:<18,} {history['total_completion']:<20,} {history['total_tokens']:<12,} |")
    print("|                                                                              |")
    print(f"|   Est. Credits Remaining: ~{estimated_credits_remaining:,} / 1,000 (Free Developer Tier)             |")
    print("+" + "-" * w + "+")

    # Breakdown by Component
    print("|  USAGE BY PIPELINE STAGE:                                                    |")
    if history["by_source"]:
        for src, val in history["by_source"].items():
            pct = round((val["tokens"] / history["total_tokens"] * 100), 1) if history["total_tokens"] > 0 else 0
            print(f"|   • {src:<20} {val['calls']:>4} calls   |  {val['tokens']:>8,} tokens  ({pct:>4}%)             |")
    else:
        print("|   (Waiting for queries... Send a chat message in the UI to see live tokens)  |")
    print("+" + "-" * w + "+")

    # Recent Live Traffic Table
    print("|  RECENT REQUEST ACTIVITY (Live Real-Time Stream):                           |")
    print("|  #   Time      Source           Model              Prompt   Compl   Total    |")
    print("|  " + "-" * 74 + " |")

    recent = history["records"]
    if recent:
        for idx, r in enumerate(recent[-10:], 1):
            t_str = r.get("time_short", "--:--:--")
            src_str = (r.get("source", "API")[:15]).ljust(15)
            mod_str = (r.get("model", "llama-3.2")[:16]).ljust(16)
            p_tok = f"{r.get('prompt_tokens', 0):,}".rjust(7)
            c_tok = f"{r.get('completion_tokens', 0):,}".rjust(6)
            tot_tok = f"{r.get('total_tokens', 0):,}".rjust(7)
            print(f"|  {idx:<2}  {t_str}  {src_str}  {mod_str}   {p_tok}  {c_tok} {tot_tok}  |")
    else:
        print("|  [No queries yet. Start chatting in the frontend to watch tokens stream in] |")
    print("+" + "-" * w + "+")

    # Status & Command Bar
    if last_status:
        print(f"|  STATUS: {last_status:<67} |")
        print("+" + "-" * w + "+")

    print("|  HOTKEYS:  [T] Test Live Query   [C] Clear Ledger   [D] Dataset Info   [Q] Quit |")
    print("+" + "-" * w + "+")


# ── Interactive Live Monitor Loop ────────────────────────────────────────────

def run_live_monitor(env_vars: Dict[str, str], refresh_sec: float = 1.0) -> None:
    """Runs continuous parallel monitor loop with hotkey support."""
    start_time = time.time()
    last_status = "Monitor active. Watching for live requests..."
    api_key = env_vars.get("NVIDIA_API_KEY", "")
    model = env_vars.get("NVIDIA_LLM_MODEL", "meta/llama-3.2-11b-vision-instruct")

    while True:
        try:
            history = load_token_history()
            render_dashboard(env_vars, history, start_time, last_status=last_status)

            # Check for keyboard input on Windows without blocking
            if WINDOWS_KEYBOARD and msvcrt.kbhit():
                key_char = msvcrt.getch().decode("utf-8", errors="ignore").lower()
                
                if key_char == "q":
                    print("\n[INFO] Exiting Token Monitor.\n")
                    break
                elif key_char == "c":
                    clear_ledger()
                    last_status = "Ledger cleared at " + datetime.now().strftime("%H:%M:%S")
                elif key_char == "t":
                    last_status = "Sending live probe to NVIDIA NIM..."
                    render_dashboard(env_vars, load_token_history(), start_time, last_status=last_status)
                    res = test_live_api_call(api_key, model=model)
                    if res.get("success"):
                        last_status = f"Probe succeeded ({res['total_tokens']} tokens, {res['latency_ms']}ms)"
                    else:
                        last_status = f"Probe failed: {res.get('error')[:40]}"
                elif key_char == "d":
                    ds = get_dataset_tokens()
                    if ds.get("found"):
                        last_status = f"Dataset: {ds['rows']:,} rows, {ds['chunks']:,} chunks -> ~{ds['tokens']:,} tokens"
                    else:
                        last_status = f"Dataset info: {ds.get('error')}"
                elif key_char == "r":
                    last_status = "Refreshed at " + datetime.now().strftime("%H:%M:%S")

            time.sleep(refresh_sec)

        except KeyboardInterrupt:
            print("\n[INFO] Monitor stopped by user (Ctrl+C).\n")
            break
        except Exception as e:
            last_status = f"Error: {str(e)[:50]}"
            time.sleep(refresh_sec)


# ── Single Snapshot Report ───────────────────────────────────────────────────

def run_single_report(env_vars: Dict[str, str]) -> None:
    """Prints a static one-off summary and exits."""
    history = load_token_history()
    ds = get_dataset_tokens()
    key = env_vars.get("NVIDIA_API_KEY", "")

    print("\n" + "=" * 74)
    print(" ⚡ NVIDIA NIM TOKEN USAGE REPORT (Snapshot)")
    print("=" * 74)
    print(f"API Key:         {mask_key(key)}")
    print(f"Model:           {env_vars.get('NVIDIA_LLM_MODEL', 'meta/llama-3.2-11b-vision-instruct')}")
    print(f"Total Requests:  {history['count']:,}")
    print(f"Prompt Tokens:   {history['total_prompt']:,}")
    print(f"Compl Tokens:    {history['total_completion']:,}")
    print(f"Total Tokens:    {history['total_tokens']:,}")
    print("-" * 74)
    if ds.get("found"):
        print(f"Dataset Chunks:  {ds['chunks']:,} chunks (~{ds['tokens']:,} tokens required to embed)")
    print("=" * 74 + "\n")


# ── Main CLI Handler ─────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Parallel Real-Time Token Monitor for NVIDIA NIM API")
    parser.add_argument("--once", action="store_true", help="Print single report and exit (no live loop)")
    parser.add_argument("--test", action="store_true", help="Send a live test prompt, record tokens, and exit")
    parser.add_argument("--clear", action="store_true", help="Clear the recorded token ledger and exit")
    parser.add_argument("--interval", type=float, default=1.0, help="Refresh interval in seconds (default: 1.0)")
    parser.add_argument("--prompt", type=str, default=None, help="Custom prompt for live test")
    args = parser.parse_args()

    env_vars = load_env_variables()
    api_key = env_vars.get("NVIDIA_API_KEY", "")

    if args.clear:
        clear_ledger()
        print("[SUCCESS] Token ledger cleared.")
        return

    if args.test:
        test_prompt = args.prompt or "Provide a 1-sentence executive summary of business gross margin."
        print(f"[INFO] Testing live API call with prompt: '{test_prompt}'...")
        res = test_live_api_call(api_key, prompt=test_prompt)
        if res.get("success"):
            print(f"✅ Success! Status: {res['status_code']} | Latency: {res['latency_ms']}ms")
            print(f"   Prompt Tokens:     {res['prompt_tokens']}")
            print(f"   Completion Tokens: {res['completion_tokens']}")
            print(f"   Total Tokens:      {res['total_tokens']}")
            print(f"   Response Preview:  \"{res['preview']}\"")
        else:
            print(f"❌ Failed! Error: {res.get('error')}")
        return

    if args.once:
        run_single_report(env_vars)
        return

    run_live_monitor(env_vars, refresh_sec=args.interval)


if __name__ == "__main__":
    main()
