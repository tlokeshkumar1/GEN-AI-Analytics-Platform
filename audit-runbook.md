# Enterprise readiness audit runbook

The audited baseline is `e2aaca9b651f8617c875400da7a90cef2a60fef6`. Start from that commit plus the retained audit deliverables/CI changes. The initial worktree was clean. Use synthetic records and isolated temporary storage.

## Local prerequisites

Python 3.12, Node 22.14 or another version compatible with the checked-in frontend lockfile, and installed backend/frontend dependencies. The audited workstation already had `backend/api/venv` and frontend node_modules. System Python lacked backend packages; that failed discovery is preserved in `audit-results.json`.

For a fresh environment, create a dedicated virtual environment and install `backend/requirements.txt` plus `httpx` (needed by FastAPI TestClient). Run `npm ci --prefix frontend`. Those clean installations were not performed as part of the application validation; current dependency ranges can resolve differently. Inspect manifests/locks and install only in the isolated audit workspace.

PowerShell commands from the repository root:

```powershell
git status --short
git rev-parse HEAD
& backend/api/venv/Scripts/python.exe scripts/run_offline_tests.py
npm test --prefix frontend -- --reporter=verbose
npm run lint --prefix frontend
npm run build --prefix frontend
& backend/api/venv/Scripts/python.exe -m pip check
```

The backend offline runner patches dotenv loading, HANA connection creation and HTTP calls, uses temporary metadata and explicitly selects development/local backends. The audit probe runner also blocks external sockets, allowing loopback connections needed by Windows asyncio. Tests have fixture-level successful HANA stubs: printed “HANA persisted” messages must not be cited as real-cloud results. Do not import/run the normal application with local `.env` values as an audit shortcut.

Expected current results: backend **269 PASS**, frontend **71 PASS / 8 FAIL**, added probes **52 PASS / 10 FAIL**, TypeScript/build PASS. The historical probe source is retained in `audit-results.json` under `audit_tool_sources["run_local_probes.py"]`; it intentionally exits 1 while defects remain. It includes ten synthetic workbooks, isolated local HTTP workflows, exact arithmetic, access/approval/SSRF checks, version history, nine planner cases and query benchmarks. It does not certify live integrations.

## Quality and dependency checks

Install Ruff/pip-audit in a separate temporary tool environment or tool target. Audited tool versions: Ruff 0.17.6, pip-audit 2.10.1. Set PYTHONPATH to that temporary target only for tool invocations if using `pip install --target`; do not overwrite the application environment. The executed scanner commands were:

```powershell
npm audit --prefix frontend --json
npm audit --prefix router --json
npm audit --prefix backend/db --json
python -m pip_audit --path backend/api/venv/Lib/site-packages --format json --output python-dependency-audit.json
python -m ruff check --isolated backend/api backend/tests scripts --output-format json --output-file python-lint.json
python -m ruff format --isolated --check backend/api backend/tests scripts
& backend/api/venv/Scripts/python.exe -m compileall -q backend/api/app.py backend/api/platform backend/api/routes backend/api/services backend/api/database scripts
```

Capture stdout/stderr and exit codes separately when rerunning. npm/pip advisory data changes with registry updates; the original JSON files are point-in-time evidence, not immutable vulnerability facts. The failed preliminary pip-audit invocations used flags that are incompatible with `--path`; only the final command above produced the recorded scan. Do not use `--fix` as part of a read-only audit.

`run_static_inventory.py` inspects tracked source and all distinct blobs reachable from Git refs. Its secret scan writes only path/blob/rule/line indicators, never matching secret values. It uses selected patterns, not exhaustive entropy/provider detection. Import-cycle results include deferred imports and length-limited paths, so they are review leads rather than runtime failures.

## Consolidated evidence and optional reproduction

Only six added files are retained: the consolidated report, results JSON, traceability CSV, remediation plan, this runbook and the CI workflow. `audit-results.json` embeds structured evidence and relevant transcripts under `supporting_evidence`, and the four audit script sources under `audit_tool_sources`. Generated workbook binaries, separate logs, helper scripts and the redundant report template were removed. The formatting log is represented by its check summary instead of verbose diagnostics.

The existing backend tests, frontend tests, typecheck, build and quality checks above remain directly runnable. To repeat the additional historical probes, extract `audit_tool_sources["run_local_probes.py"]` to `docs/audits/run_local_probes.py`, then run it with the backend Python environment from the repository root. It will regenerate temporary supporting outputs and synthetic workbooks; those are not required retained deliverables. The static inventory source can be extracted in the same way if needed. The original finalizer depended on a removed template and is retained as historical source, not a ready-to-run report generator.

Historical commands and findings refer to files present during the original audit. Consult their embedded outputs rather than expecting those generated files to exist. After any new audit, update the report, matrix and JSON from newly executed evidence; do not retain old PASS claims without rerunning the corresponding checks.

## Real HANA / AI / connector verification — currently BLOCKED

Obtain an explicitly approved **test** service binding, isolated schema name, non-production user, permitted tables and cleanup policy before executing any live integration. A local credential file is not proof that its target is disposable. Never infer a test schema from production connection settings. Do not run application initialization, migrations, upload storage actions, cascade deletion or GC against an unknown schema.

Use a separate manually dispatched CI workflow with a protected environment and reviewers; ordinary PR/push jobs must not receive cloud credentials. Require explicit test-only secrets and schema allowlisting, then fail closed if missing. The added local CI workflow does not implement or run cloud integrations.

In that approved environment, create a uniquely named disposable schema/dataset namespace; independently verify that the resolved target is the allowlisted schema. Capture:

1. TLS/authentication, privileges, pool/timeouts and reconnect behavior.
2. Migration/HDI compatibility, dynamic object identifiers and parameterized malicious-value rejection.
3. Commit/rollback/fault recovery and concurrent version allocation with no partial published version.
4. Vector dimensions/model metadata, cosine retrieval, tenant/dataset/version filters and historical retrieval after updates/rollback.
5. Approved analytics and dashboard reconciliation, independent numerical expectations, join cardinalities and history on both sides.
6. Each external connector's actual auth, schema mapping, pagination, incremental updates/deletions, checkpoint/retry, quota and credential rotation.
7. Real RAG known-answer evaluation: dataset/version/source IDs, expected answers, correctness, citation precision, timeout/injection failures and token consumption.
8. Clean up only objects created in the verified disposable namespace; record what was removed. Never sweep or delete production tables.

Do not mark these checks PASS until they actually execute. Keep provider mocks in separate unit results.

## Browser and load verification — currently incomplete

Run all twelve requested screens in an actual browser against the approved local/test deployment with real role/session boundaries. Cover loading, empty, success, error and recovery, keyboard/screen-reader behavior, responsive layouts, charts, SSE interruption/reconnect and logout cleanup. happy-dom component tests do not substitute for this run.

The existing benchmark measures in-process SUM queries at 1k/10k/100k/1m rows and short batches of 1/10/25/50/100 threads. It records interpolated p50/p95/p99, throughput, result error rate, process CPU seconds and input-frame size. It does not measure authenticated users, full ingestion, HANA plans, memory growth, sustained CPU utilization, first-token latency or embeddings. Fix the permit leak before sustained pool-fault/load tests; agree on SLOs and resource budgets, then run against approved test infrastructure only.

Final release review must confirm no unresolved critical/high issues, green mandatory CI, live integration evidence, browser/accessibility coverage, agreed load/recovery SLOs, reproducible deployment artifacts and a managed secret/key lifecycle. The present audit does not meet those gates.
