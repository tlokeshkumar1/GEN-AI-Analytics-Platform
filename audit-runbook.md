# Enterprise audit runbook

## Scope and prerequisites

Audit the application commit `de7e2aec653200c8df92670176a9839aae71b59c`. Use Python 3.12 and Node 22 (CI) or the locally verified Node 24. Existing tools are pinned in backend/requirements-ci.txt. Do not read or publish local bindings, .env, private MTA extensions or encryption keys. No live target is authorized by its mere presence on disk.

Use a dedicated branch/worktree at the audited commit. Record git status and SHA before execution. Do not overwrite concurrent user changes. Audit tools added after the application commit are in docs/audits and embedded in audit-results.json. The generated ci-results/ directory is ignored; regenerate it when reviewing a clean checkout.

## Install verification dependencies

PowerShell commands below run from repository root. Use the existing backend/venv interpreter or create an isolated environment. Run each command only after checking the previous result. Dependency installation uses package registries; application/provider calls are prohibited in offline stages.

```powershell
backend/venv/Scripts/python.exe -m pip install -r backend/requirements.txt -r backend/requirements-ci.txt
```

The baseline driver copies frontend sources to a temporary directory, avoiding native-file locks in a running Windows Vite server. Do not run npm ci against an actively used node_modules directory. The driver preserves full stdout/stderr and exact exit codes in ci-results/enterprise-audit.

## Reproduce local checks

Run existing suites before changing/adding audit probes. The maintained offline runner disables HTTP/HANA and dotenv loading; live integration success is never inferred from it.

```powershell
backend/venv/Scripts/python.exe docs/audits/run_verification.py --stage baseline
backend/venv/Scripts/python.exe docs/audits/run_verification.py --stage checks
backend/venv/Scripts/python.exe docs/audits/run_verification.py --stage inventory
backend/venv/Scripts/python.exe docs/audits/run_verification.py --stage probes
backend/venv/Scripts/python.exe docs/audits/run_deployment_audit.py
```

Expected audited-commit results: baseline exit 0 (backend 270, frontend 79); checks exit 1 because the separately executed expanded Ruff defaults still fail, while maintained quality/build/scanners pass; inventory exit 0 with 919 reachable blobs scanned and zero pattern indicators; probes exit 1 with 56 PASS/20 FAIL; clean SAP build audit exit 1 because mta.yaml is untracked. Do not convert these failures to PASS or add continue-on-error to CI. Compare the ledger and actual output if results differ.

The probe runner patches credentials/readers/network, redirects metadata/datasets/objects/token accounting to temporary storage, and tests small synthetic payloads. Real worksheet formulas are not executed. No cloud table is created/deleted. An external socket is denied while loopback event-loop plumbing is permitted on Windows. Changed-domain fixtures verify v2=51 and pinned v1=50. Benchmarks run last and are pandas-only, not real-user load.

## Browser checks

Install browser tooling only into temporary storage. The application package manifests are not changed. A local Edge/Chrome executable is required; otherwise record this stage BLOCKED. On Linux provide an approved browser executable and adapt the executable discovery in run_browser_audit.cjs; the existing frontend/backend CI matrix remains independently verified on Ubuntu/Windows.

```powershell
npm install --prefix "$env:TEMP/genai-audit-browser-tools" playwright-core @axe-core/playwright
node docs/audits/run_browser_audit.cjs
```

The script serves only the compiled temporary frontend, uses synthetic API responses and blocks all external page requests. It checks 1440px desktop and selected 390px mobile screens, exact dashboard 42, controlled outage/Refresh recovery/loading, sign-in, Member navigation/deep link and HANA availability. Expected exit 1: 20 behavior PASS/2 FAIL, plus four axe rule categories. External fonts/icons are blocked, so visual findings are scoped accordingly. Screenshots and detailed selectors are local generated artifacts, not proof of live SAP integration.

## Consolidate and validate

```powershell
backend/venv/Scripts/python.exe docs/audits/finalize_audit.py
backend/venv/Scripts/python.exe docs/audits/validate_audit.py
```

The finalizer uses the audited source commit from source-inventory.json, preserves historical findings with explicit current statuses, and generates all five deliverables. The validator checks JSON/CSV counts, readiness numerator/denominator, actual failure evidence/source anchors, evidence hashes, report sections and untouched application files. Generated report-deliverable PASS means artifact completeness; these rows are excluded from application readiness scoring.

## Authorized SAP HANA / XSUAA / provider validation

This section is a future operator procedure, not authorization to execute cloud operations now.

1. Obtain explicit target authorization: disposable HANA instance/schema or HDI container, test XSUAA tenant, named test users/roles, model deployments and connector test accounts. Record target identifiers through approved private controls, not public audit artifacts. Confirm no production schema/table is included.
2. Fix F11 first: track a sanitized mta.yaml and validate a clean `mbt build`. Keep secrets only in protected bindings/private extensions. Any test-space deployment follows the existing manual SAP Cloud Foundry process with separate approval. GitHub Actions remains CI only.
3. Provision only explicitly approved disposable schemas/tables with unique audit-run identifiers. Review all migration identifiers and apply migrations 001/002/003 in order only to the test schema. Verify table/synonym/view definitions before exercising API paths.
4. Verify real TLS trust, XSUAA signature/issuer/audience/expiry/scopes, unauthenticated/Member/Admin behavior, two-user dataset/chat/citation isolation and SAP logout/refresh. Never use dev-token fixtures as live-auth evidence.
5. Run real HANA exact aggregates, independent duplicate/null/composite/cardinality cases, explicit left/right historical version fixtures, transaction rollback/commit/partial-write tests, pool saturation/discard/reconnect and cascade deletion limited to run-owned fixtures. Require deterministic expected values and capture SQL plans/timing without sensitive row contents.
6. Configure one stable managed encryption key for API and worker replicas. Verify existing encrypted test credentials, rotation/restart/replica interoperability and safe failures. Do not replace a production key or migrate real credentials in an audit run.
7. Verify embedding model/dimension versions, cosine retrieval, dataset/version filters and known-answer generated responses/citations. Record correctness, citation precision, unsupported-question and injection/failure categories. Retain actual provider/model identifiers and token/cost telemetry with secrets redacted.
8. Exercise REST/SOAP/OData/SAP/S3/GCS/Azure authentication, pagination, rate-limit/backoff, checkpoints, incremental sync and credential rotation only against approved test targets.
9. Agree stop conditions, budgets and service SLOs before load. Run 1k/10k/100k/1m where resources permit and authenticated 1/10/25/50/100-user ingestion/RAG/dashboard workloads on isolated infrastructure. Record p50/p95/p99, throughput/errors, CPU/RSS growth, stream and embedding throughput; do not substitute pandas query threads for users.
10. Verify dependency-aware readiness/liveness, worker heartbeat/lease recovery and process shutdown/restart. Clean up only the enumerated run-owned fixtures through reviewed identifiers; never issue broad DROP/DELETE against production.
11. Record every executed command/status/output and update only verified requirements. Leave unavailable provider checks BLOCKED and incomplete browser/load scopes NOT TESTED. Reassess release gates only after all P0/high arithmetic/security findings are resolved and independently verified.

## Artifacts and historical recovery

- Current report: docs/audits/ENTERPRISE_READINESS_AUDIT.md
- Machine results and embedded evidence/tool sources: audit-results.json
- Requirement matrix: audit-test-matrix.csv
- Fix batches: audit-remediation-plan.md
- This procedure: audit-runbook.md
- Prior consolidated evidence: `git show de7e2aec653200c8df92670176a9839aae71b59c:audit-results.json`
- Hosted CI evidence: https://github.com/tlokeshkumar1/GEN-AI-Analytics-Platform/actions/runs/45332006900

No production-readiness or compliance claim follows from a green command alone. Explicit scopes and limitations remain part of every result.
