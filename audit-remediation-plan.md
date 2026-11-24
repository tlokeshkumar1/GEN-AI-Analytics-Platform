# Enterprise audit remediation plan

Application baseline: `de7e2aec653200c8df92670176a9839aae71b59c`. This audit made no application fixes or deployments. F09/F12/F13 remain verified resolved from prior work. Do not infer enterprise readiness from green CI.

## Sequence and acceptance

1. Security defaults: F01, F02, F05, F06, F08, F14, F15, F19. Add negative server-side tests first, use disposable storage and preserve legitimate private connector configuration through explicit trusted policy.
2. Data correctness: F03, F07, F16. Require independently calculated totals, duplicate/null/composite/cardinality checks and explicitly pinned historical joins. Coordinate any decimal API representation change with the frontend.
3. Reliability and SAP build: F04, F11, F17. Implement exactly-once pool accounting, dependency-aware readiness/quotas and track sanitized manifests. Build/hosting stays SAP BTP Cloud Foundry; no deployment in GitHub Actions.
4. Product/accessibility: F10, F20, F21, F22. Ground reports and availability in actual results; add accessible labels/roles/contrast and UI route guards while preserving backend authorization.
5. Quality/ownership: F18. Keep all existing tests and scanners green; triage expanded lint by rule instead of marking it fixed because the maintained selection passes. Refactor duplicates only after reachability and regression checks.
6. Authorized live validation and scale: follow audit-runbook.md. Keep all real provider checks BLOCKED until they execute against approved isolated targets.

## Finding-level work

### F01 - Unsafe semantic approval defaults and rejected-model execution

Priority: **P0**. Status: **OPEN**. Source: `backend/api/platform/semantic.py:123`.

Require explicit human approval by default and reject rejected/stale revisions even in opt-in development mode.

Regression/evidence: `production_semantic_review_defaults_fail_closed`, `rejected_semantic_model_cannot_execute`.

### F02 - Chat workspace policy bypasses dataset grants

Priority: **P0**. Status: **OPEN**. Source: `backend/api/models/execution_context.py:58`.

Enforce dataset read grants before retrieval, execution and citation emission; separately audit cross-account caches.

Regression/evidence: `dataset_grants_chat_read`.

### F03 - Dynamic joins amplify rows and match null keys

Priority: **P0**. Status: **OPEN**. Source: `backend/api/platform/join_service.py:514`.

Unify dynamic and reviewed joins under explicit cardinality, duplicate/null/composite-key validation.

Regression/evidence: `dynamic_join_amplification_rejected`, `dynamic_join_null_keys_do_not_match`.

### F04 - Failed metadata connections leak pool permits

Priority: **P1**. Status: **OPEN**. Source: `backend/api/platform/store.py:87`.

Add one exactly-once pool discard/release operation and test cursor/commit/rollback failures repeatedly.

Regression/evidence: `pool_capacity_released_after_metadata_failure`.

### F05 - Connector endpoint checks lack IP/DNS classification

Priority: **P0**. Status: **OPEN**. Source: `backend/api/platform/connectors.py:54`.

Classify and pin resolved addresses at connection time; block metadata/loopback/private ranges unless explicitly trusted by a constrained policy.

Regression/evidence: `ssrf_loopback_rejected`, `allowlisted_dns_metadata_resolution_rejected`.

### F06 - Unsigned development token grants Admin without separate opt-in

Priority: **P1**. Status: **OPEN**. Source: `backend/api/xsuaa.py:112`.

Require disabled-by-default local dev-auth opt-in and refuse development auth on deployed runtimes. This is not a demonstrated production XSUAA signature bypass.

Regression/evidence: `unsigned_development_token_rejected`.

### F07 - API serialization loses exact Decimal cents

Priority: **P1**. Status: **OPEN**. Source: `backend/api/services/analytics_engine.py:57`.

Preserve exact decimals in a documented API representation and update frontend formatting without float conversion.

Regression/evidence: `math_large_decimal_response_precision`.

### F08 - XLSX export turns untrusted text into formula cells

Priority: **P1**. Status: **OPEN**. Source: `backend/api/services/dataset_service.py:243`.

Export user text as literal cells; add cell-type and CSV-consumer regressions. No formula payload was executed.

Regression/evidence: `xlsx_export_preserves_formula_text_as_literal`.

### F09 - Previously vulnerable scanned dependency resolutions

Priority: **P0**. Status: **FIXED**. Source: `backend/requirements.txt:16`.

Keep lockfiles/requirements scanned; current npm and pip-audit results contain zero known vulnerabilities.

Regression/evidence: See the scan, baseline suite, browser result or clean-build evidence linked in audit-results.json..

### F10 - Data-backed reports absent; demo contains fabricated compliance statement

Priority: **P2**. Status: **OPEN**. Source: `frontend/src/screens/ReportsLibrary.tsx:53`.

Implement reports with real dataset/version/KPI provenance and remove unsupported claims from the opt-in demo. Default App.tsx route is a placeholder, not a compliance claim.

Regression/evidence: See the scan, baseline suite, browser result or clean-build evidence linked in audit-results.json..

### F11 - Required SAP MTA manifest is not reproducible from Git

Priority: **P1**. Status: **OPEN**. Source: `.gitignore:17`.

Track a sanitized non-secret MTA manifest; verify clean SAP builds and manual test-space deployment through the existing CF process.

Regression/evidence: See the scan, baseline suite, browser result or clean-build evidence linked in audit-results.json..

### F12 - Historical frontend component failures

Priority: **P1**. Status: **FIXED**. Source: `frontend/src/__tests__/platform.test.tsx:66`.

Current complete frontend suite passes 79/79; preserve the Widgets route fixtures and assertions.

Regression/evidence: See the scan, baseline suite, browser result or clean-build evidence linked in audit-results.json..

### F13 - Undefined logger masked recommendation retry failures

Priority: **P1**. Status: **FIXED**. Source: `backend/api/routes/datasets.py:16`.

Defined logger and isolated failure-path regression verified in the 270-test baseline.

Regression/evidence: See the scan, baseline suite, browser result or clean-build evidence linked in audit-results.json..

### F14 - Upload discovery/preview read entire files; workbook budgets missing

Priority: **P1**. Status: **OPEN**. Source: `backend/api/routes/semantic.py:216`.

Share bounded readers across all endpoints and enforce decompressed ZIP, sheet/row/column and parser budgets; add small adversarial fixtures.

Regression/evidence: `upload_discovery_uses_bounded_reads`.

### F15 - Production credential key silently falls back to local generation

Priority: **P1**. Status: **OPEN**. Source: `backend/api/platform/connections.py:20`.

Require one managed stable key across API/workers, fail closed when absent and document backward-compatible rotation. Probe did not read/write actual credential files.

Regression/evidence: `production_missing_encryption_key_fails_closed`.

### F16 - Historical dynamic join silently uses current right-side version

Priority: **P1**. Status: **OPEN**. Source: `backend/api/platform/join_service.py:482`.

Require explicit version/revision pins on both sides; historical fixture observes Amount=10 with Factor=3 instead of intended Factor=2.

Regression/evidence: `historical_dynamic_join_preserves_both_versions`.

### F17 - Readiness returns 200 on unavailable database; quotas absent

Priority: **P1**. Status: **OPEN**. Source: `backend/api/routes/health.py:10`.

Separate liveness/readiness with dependency-aware HTTP status; enforce request/upload/model budgets and worker reporting.

Regression/evidence: `unavailable_database_is_not_ready_http_status`.

### F18 - Configured quality gate passes but expanded lint/duplication remains

Priority: **P2**. Status: **PARTIALLY FIXED**. Source: `ruff.toml:5`.

Keep owned pinned quality gates; triage expanded Ruff diagnostics and duplicate source paths rather than claiming them remediated.

Regression/evidence: See the scan, baseline suite, browser result or clean-build evidence linked in audit-results.json..

### F19 - Internal metadata exception text is exposed in HTTP detail

Priority: **P1**. Status: **OPEN**. Source: `backend/api/platform/store.py:80`.

Return a generic storage error/correlation ID and redact provider detail in server logs; extend coverage to other raw driver-error responses.

Regression/evidence: `metadata_errors_redact_internal_details`.

### F20 - Accessible names, labels, contrast and loading ARIA fail browser checks

Priority: **P1**. Status: **OPEN**. Source: `frontend/src/screens/ExecutiveDashboard.tsx:268`.

Associate form labels/select names, correct ARIA roles and contrast; rerun real-browser axe and manual keyboard/screen-reader checks.

Regression/evidence: See the scan, baseline suite, browser result or clean-build evidence linked in audit-results.json..

### F21 - Member deep link opens HANA admin UI

Priority: **P2**. Status: **OPEN**. Source: `frontend/src/App.tsx:77`.

Guard admin routes in App as well as navigation. Backend require_admin correctly rejects the Member before database access; no data escalation demonstrated.

Regression/evidence: See the scan, baseline suite, browser result or clean-build evidence linked in audit-results.json..

### F22 - HANA admin hardcodes Online after provider failure

Priority: **P2**. Status: **OPEN**. Source: `frontend/src/screens/HanaAdmin.tsx:375`.

Derive availability from actual verified response; render unknown/loading/offline on failures instead of unconditional Online.

Regression/evidence: See the scan, baseline suite, browser result or clean-build evidence linked in audit-results.json..

## Completion gates

- Every fixed defect has a failing-before/passing-after isolated regression without weakening existing assertions.
- Complete backend/frontend/TypeScript/build/maintained lint/format/dependency gates pass on Windows and Ubuntu.
- Negative approval/access/SSRF/token/export/upload/key/redaction tests pass with production-safe defaults.
- Exact Decimal and cardinality/version fixtures match independently specified results.
- Clean tracked SAP MTA build is reproducible; private extensions/bindings and keys stay outside Git.
- Real HANA/XSUAA/model/connector, accessibility and agreed load/recovery gates have executed evidence. No provider stand-in is promoted to a live PASS.
- Audit matrix/results/report are regenerated and validated; original findings and limitations retained.

## P3 follow-up

Assign actual module owners/CODEOWNERS; review three duplicate source pairs and unused legacy Sales contracts; stop tracking mutable runtime token telemetry and define tenant/user-aware cost accounting; self-host or define an approved fallback for externally loaded fonts/icons; expand long-duration load, failure recovery and provider-backed evaluation.
