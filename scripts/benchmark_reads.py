"""Benchmark an existing deployment with distinct authenticated test accounts.

Users file: [{"token_env": "TEST_USER_001_TOKEN", "dataset_id": "...",
              "expected_rows": 10000000, "denied_dataset_id": "..."}, ...]
Tokens are read from environment variables and never written to the report.
No datasets are created or modified by this benchmark.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import math
import os
from pathlib import Path
import time
from urllib.parse import urlsplit

import requests


def percentile(values, quantile):
    values = sorted(values)
    return values[min(len(values) - 1, max(0, math.ceil(len(values) * quantile) - 1))] if values else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--users-file", type=Path, required=True)
    parser.add_argument("--users", type=int, default=100)
    parser.add_argument("--requests-per-user", type=int, default=5)
    parser.add_argument("--page-size", type=int, default=50)
    parser.add_argument("--max-page", type=int, default=3)
    parser.add_argument("--min-dataset-rows", type=int, default=10000000)
    parser.add_argument("--p95-ms", type=float, default=2000)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    url = urlsplit(args.base_url)
    if url.scheme not in ("http", "https") or url.username or url.password or url.query or url.fragment:
        parser.error("Use an HTTP(S) deployment URL without credentials, query parameters, or fragments.")
    if min(args.users, args.requests_per_user, args.max_page) < 1 or not 1 <= args.page_size <= 500:
        parser.error("Counts must be positive; page size must be between 1 and 500.")
    users = json.loads(args.users_file.read_text(encoding="utf-8-sig"))[:args.users]
    if len(users) < args.users:
        parser.error("Provide one test-account configuration per concurrent user.")
    if max(user.get("expected_rows", 0) for user in users) < args.min_dataset_rows:
        parser.error("The workload does not include a dataset meeting --min-dataset-rows.")
    base = args.base_url.rstrip("/")

    def authenticate(user):
        session = requests.Session()
        session.trust_env = False
        token = os.environ.get(user["token_env"])
        if not token:
            session.close()
            raise RuntimeError("A configured test token environment variable is missing.")
        session.headers["Authorization"] = "Bearer " + token
        response = session.get(base + "/api/auth/me", timeout=20)
        if response.status_code != 200:
            session.close()
            raise RuntimeError(f"A test account could not authenticate (HTTP {response.status_code}).")
        identity = response.json().get("user_id")
        if not identity:
            session.close()
            raise RuntimeError("A test account returned no verified user ID.")
        return session, identity, user

    sessions = []
    try:
        with ThreadPoolExecutor(max_workers=args.users) as pool:
            sessions = list(pool.map(authenticate, users))
        if len({identity for _, identity, _ in sessions}) != args.users:
            raise RuntimeError("Use distinct authenticated accounts; concurrent clients with one token are not multiple users.")

        def read(runtime):
            session, _, user = runtime
            measurements = []
            failures = []
            if user.get("denied_dataset_id"):
                denied = session.get(base + f"/api/datasets/{user['denied_dataset_id']}/preview", timeout=20)
                if denied.status_code not in (403, 404):
                    failures.append("Cross-account access was not denied.")
            pages = min(args.max_page, max(1, math.ceil(user["expected_rows"] / args.page_size)))
            for number in range(args.requests_per_user):
                started = time.perf_counter()
                try:
                    response = session.get(base + f"/api/datasets/{user['dataset_id']}/preview",
                                           params={"page": 1 + number % pages, "pageSize": args.page_size}, timeout=30)
                    elapsed = (time.perf_counter() - started) * 1000
                    if response.status_code != 200:
                        failures.append(f"Page request failed (HTTP {response.status_code}).")
                        continue
                    body = response.json()
                    if body.get("totalRows") != user["expected_rows"] or len(body.get("rows", [])) > args.page_size:
                        failures.append("Unexpected row count or unbounded page response.")
                        continue
                    measurements.append(elapsed)
                except requests.RequestException:
                    failures.append("Page request failed or timed out.")
            return measurements, failures

        started = time.perf_counter()
        with ThreadPoolExecutor(max_workers=args.users) as pool:
            runs = list(pool.map(read, sessions))
        duration = time.perf_counter() - started
        timings = [elapsed for measurements, _ in runs for elapsed in measurements]
        failures = [error for _, errors in runs for error in errors]
        p95 = percentile(timings, .95)
        result = {
            "concurrent_distinct_users": args.users,
            "largest_dataset_rows": max(user["expected_rows"] for user in users),
            "page_size": args.page_size, "tested_page_range": [1, args.max_page],
            "successful_requests": len(timings), "failures": failures,
            "p50_ms": percentile(timings, .50), "p95_ms": p95, "p99_ms": percentile(timings, .99),
            "requests_per_second": len(timings) / duration,
            "p95_budget_ms": args.p95_ms,
            "passed": not failures and p95 is not None and p95 <= args.p95_ms,
            "scope": "Read-only table previews on the supplied deployment; charts, ingestion and deep pagination require separate workloads.",
        }
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result, indent=2))
        return 0 if result["passed"] else 1
    finally:
        for session, _, _ in sessions:
            session.close()


if __name__ == "__main__":
    raise SystemExit(main())
