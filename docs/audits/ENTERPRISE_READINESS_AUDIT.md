# GEN-AI Analytics Platform — Enterprise Readiness Audit

Audit date: **23 November 2026 (Asia/Calcutta)**. Audited Git commit: **`e2aaca9b651f8617c875400da7a90cef2a60fef6`**. The initial worktree was clean. Added audit files and CI are uncommitted changes relative to that commit; production source and lockfiles were not changed.

## 1. Executive assessment

**NOT ENTERPRISE READY / NO GO.** This is a substantial implementation with working local analytics and review flows, rather than only a README demonstration. However, reproducible security, numerical, join and failure-recovery defects remain. Cloud functionality, deployment behavior, real-browser UX and service-level scalability have not been demonstrated.

The existing backend suite passes **269/269** tests in the repository virtual environment. Frontend component tests pass **71/79**, with **8 failures**. Added local audit checks pass **52/62**, with **10 reproducible requirement failures**. TypeScript and the production frontend build pass. Passing unit tests with substituted providers do not establish live SAP HANA, XSUAA, connector or LLM success.

Highest-value fixes: enforce an explicit enterprise review/access policy, make both join paths cardinality-safe and version-pinned, release pool permits on discarded connections, preserve decimal values at serialization, address dependency advisories, and restore a tracked deployable configuration. The Reports Library currently generates an unsupported compliance assertion; remove that assertion and implement data-backed reporting.

## 2. Evidence boundary and status definitions

PASS means the named verification actually executed successfully, including a clearly scoped static inspection. FAIL means a check executed and its requirement was not met. BLOCKED means the complete check needs an unavailable or unapproved service, credentials or infrastructure. NOT IMPLEMENTED identifies absent required behavior. NOT TESTED means the verification has not been attempted for its complete stated scope.

The matrix's `verification` and `limitation` columns define what each status means. A local PASS is not a live-cloud PASS. A whole-screen NOT TESTED can coexist with passing individual component tests. Requirements and tests are different counting units; a bundled domain check contains several assertions, and existing tests can support several requirements.

The original brief was traced into **222** enumerated requirements before new probes were written. Ten supplemental rows capture requirements expressed outside those lists. [Full traceability matrix](../../audit-test-matrix.csv) connects every row to implementation, verification, evidence and limitations. [Machine-readable results](../../audit-results.json) contains test outcomes, benchmark samples and the command ledger. Supporting evidence and audit script sources are consolidated into `audit-results.json` under `supporting_evidence` and `audit_tool_sources`; separate generated files were removed at the user's request.

No live HANA instance or explicitly disposable schema was identified. Local credential files exist but were not exposed, used to select a target or taken as authorization for production testing. HANA/HTTP provider calls were blocked by the runners. The added runner also blocks external socket connections while permitting Windows event-loop loopback plumbing. Only package-registry/advisory traffic was used for audit tooling and dependency scans. No cloud table was created, overwritten or deleted.

The offline suite may print “Clean data persisted to HANA” because its HANA writer is a successful test double. **Those log messages are not real integration evidence.** Synthetic fixtures and temporary directories were used throughout. The first system-Python run encountered missing `jwt`/`cryptography`; its 30 import errors are an environment blocker resolved by using the existing virtual environment, not 30 platform defects. Two initial pip-audit flag combinations were invalid; the final successful scanner invocation and JSON are recorded below. The HTTP probe harness was corrected to allow Windows loopback sockets and calculate expectations from the actual selected recommendation; intermediate harness failures are not counted as product defects.

## 3. Counts and readiness rubric

| Status | Requirements |
|---|---:|
| PASS | 101 |
| FAIL | 29 |
| BLOCKED | 55 |
| NOT IMPLEMENTED | 9 |
| NOT TESTED | 38 |

Total: **232** requirements (222 extracted items + 10 supplemental checks). Weighted evidence score: **33.8/100** (119/352).

| Suite | PASS | FAIL |
|---|---:|---:|
| backend | 269 | 0 |
| frontend | 71 | 8 |
| audit_probes | 52 | 10 |

| Phase | PASS | FAIL | BLOCKED | NOT IMPLEMENTED | NOT TESTED |
|---:|---:|---:|---:|---:|---:|
| 1 | 5 | 6 | 3 | 1 | 0 |
| 2 | 27 | 1 | 3 | 1 | 4 |
| 3 | 0 | 0 | 18 | 0 | 0 |
| 4 | 5 | 8 | 2 | 2 | 8 |
| 5 | 14 | 5 | 0 | 0 | 0 |
| 6 | 17 | 1 | 2 | 0 | 1 |
| 7 | 17 | 0 | 1 | 1 | 2 |
| 8 | 4 | 0 | 14 | 0 | 0 |
| 9 | 1 | 0 | 10 | 1 | 1 |
| 10 | 1 | 1 | 0 | 1 | 12 |
| 11 | 6 | 1 | 0 | 0 | 7 |
| 12 | 4 | 6 | 2 | 2 | 3 |


Weights are **3** for phases 3 (real HANA), 4 (security) and 12 (deployment/CI), and **1** for all other phases. Score = `100 × weighted PASS rows / all weighted rows`. FAIL, BLOCKED, NOT IMPLEMENTED and NOT TESTED each earn zero. This is an evidence score, not a probability of reliability or a compliance certification. Multiple related rows are deliberately retained for traceability.

Interpretation: 0–49 incomplete; 50–79 preproduction; 80–94 candidate; 95–100 eligible for readiness review. **Mandatory gates override the numeric score:** no open critical/high findings; verified isolated live HANA/XSUAA/LLM/connector paths; green required CI; real-browser accessibility/authorization checks; agreed service load and recovery SLOs. Those gates are not satisfied.

## 4. Architecture and ownership

The source inventory covers **321 tracked files** and **269 existing backend test methods** across 32 test files. [consolidated Inventory](../../audit-results.json) lists paths, sizes, imports, test names/lines, exact duplicate sources and installed Python versions. No tracked CODEOWNERS or formal module ownership was found; the following is an inferred responsibility map, not an organizational ownership claim.

| Responsibility | Implementation | Verified evidence / limits |
|---|---|---|
| HTTP API and request context | `backend/api/app.py:28`; `utils/context_middleware.py:19`; `models/execution_context.py:11` | 14 source routers registered; 101 declared method/path pairs unique; OpenAPI has 91 paths. Local HTTP context/authorization tests pass. |
| React integration | `frontend/src/App.tsx`; `services/api.ts:5`; `services/executionContext.ts` | `/api`, bearer/context headers, CSRF token handling and SSE helpers exist; typecheck/build pass; eight component failures. No real browser session. |
| Agent 1 | `platform/ingestion.py`; `platform/agent_preprocessing.py:34`; `services/upload_service.py` | Parsing/profiling/transform plan and cleaning are separate stages. Complex-header, locale and invalid-value tests pass. Automatic cleaning can remediate nulls; it is not equivalent to the conservative parser. |
| Agent 2 | `platform/agent_domain_classifier.py:196`; `platform/semantic.py:99` | LLM prompt sees first five rows plus profiles; physical type checks and title/name fallback exist. Roles and fallback tested; open-domain quality and sampling bias not established. |
| Agent 3 | `platform/agent_chart_recommender.py:274`; `platform/semantic.py:252` | Validated plans, duplicate detection and preview exist. Ten-domain local recommendations pass; business relevance is not independently scored by domain experts. |
| Orchestration | `platform/workflow.py:43`; `platform/jobs.py:115`; `worker.py:11` | Persisted stage outputs, optimistic revisions, leases, retries and heartbeats exist. Unit recovery cases pass; no real multi-replica kill/restart exercise. |
| Metadata and versions | `platform/store.py:20`; `platform/storage.py:108`; `services/dataset_service.py:538,1368` | SQLite development/HANA production adapters; snapshots and object hashes; catalog revisions. Local historical data/rollback works. HANA transactions and migrations blocked. |
| Deterministic analytics | `services/analytics_engine.py:156,300`; `models/query_plan.py:77`; `platform/formulas.py:7` | Allowlisted plans, Decimal internals and AST arithmetic. Scalar correctness passes; large-decimal serialization and dynamic joins fail. |
| Joins | `platform/formulas.py:45`; `platform/join_service.py:369` | Two distinct execution paths: reviewed relationships enforce uniqueness; dynamic dataset joins call unrestricted pandas merge. This inconsistency produces defects. |
| RAG and models | `rag/pipeline.py:40`; `rag/evidence.py`; `services/vector_service.py`; `database/vector_client.py` | Structured calculation, hybrid retrieval, source selection, history and streaming exist. Provider behavior/quality blocked; deterministic planner evaluation is separate. |
| Authentication | `xsuaa.py:80`; `routes/auth.py`; `router/xs-app.json` | sap-xssec token validation plus audience/tenant checks; synthetic RSA/expired/forged token cases pass. Development bearer-prefix bypass exists. Live SAP trust/session flow blocked. |
| Connectors | `platform/connectors.py:48,93,209,343,399`; `connections.py`; `jobs.py:204` | REST/SOAP/OData/SAP/object SDK adapters are implemented. Unit stand-ins pass; all ten real service checks blocked. |
| Deployment | `scripts/deploy.sh:14`; `backend/Procfile`; `xs-security.json`; `backend/db/src` | Local `mta.yaml` exists but is ignored/untracked. No BTP deployment or clean-checkout MTA build executed. |

The static import graph found **294 cycles of length up to eight when deferred imports are included**. This is not 294 runtime import errors: application import/OpenAPI generation succeeded, and many imports are intentionally deferred. Three exact frontend duplicate pairs exist under `frontend/components`/`frontend/src/components` and `frontend/lib`/`frontend/src/lib`. Ruff reports unused imports/variables and an undefined logger. Exhaustive dead-code and unused-dependency reachability analysis was not executed.

Global state includes active-dataset catalog selection, dashboard/semantic/recommendation/intent caches, the XSUAA credential cache, dataset index futures, and the process connection pool. ContextVars and several locks reduce cross-request leakage, but cross-process cache invalidation, tenant-complete keys, worker restarts and soak memory behavior remain unverified. The pool failure below is reproducible even without concurrency.

## 5. Critical findings and reproducible defects

Severity describes the observed issue and affected configuration, not a claim that exploitation occurred. The audit ran `backend/api/venv/Scripts/python.exe docs/audits/run_local_probes.py` (source now embedded in `audit-results.json`); [consolidated probe JSON](../../audit-results.json) records exact expected/actual values. Source lines refer to the audited commit unless marked local/untracked. Abbreviated `platform/`, `models/`, `services/`, `routes/`, `xsuaa.py` and `app.py` paths are relative to `backend/api/`; `.gitignore` is at repository root.

| ID / priority | Severity | Evidence and reproduction | Consequence / required fix |
|---|---|---|---|
| F01 / P0 | High | `platform/semantic.py:92-96`; default `PLATFORM_AUTO_APPROVE_SEMANTICS=true` permits a proposed model when `approved=True`. Probe `unapproved_semantics_rejected_default` FAIL; strict false setting rejects correctly. `persist_recommendations` also auto-approves by default at line 222. Existing `test_default_auto_approval_and_explicit_review_option` deliberately accepts this product policy. | Enterprise human-review requirement is not met by default. Make enterprise policy explicit and fail closed; do not bypass rejected models. Publication endpoint itself rejects items whose status is not approved, which passes strict-mode tests. |
| F02 / P0 | High | `models/execution_context.py:45-50`; Member outsider has no reader/writer grants but `require_dataset_access(...,for_chat=True)` succeeds when default workspace chat policy is true. `dataset_grants_chat_read` FAIL; normal read and strict setting reject. | Dataset restrictions do not restrict workspace chat by default. This is an intentional existing policy, not cross-tenant access; align ACL enforcement with enterprise requirements and test every retrieval path. |
| F03 / P0 | High | `platform/join_service.py:410`; dynamic merge lacks `validate=` and null-key filtering. One left row `(x,10)` joined to two right `(x,...)` rows produces two rows and an amplified total. Null-to-null inner join returns one row, expected zero. Both probes FAIL. Reviewed `validated_join` rejects duplicate keys and passes its probe. | Dynamic joins can silently corrupt totals. Route both paths through reviewed cardinality/key/null validation and reject ambiguous/many-to-many expansion unless explicitly modeled. |
| F04 / P1 | High | `platform/store.py:69-73` closes a failed HANA connection without returning/releasing its manager permit. With pool size one and a synthetic cursor failure, next permit acquisition times out: `pool_capacity_released_after_metadata_failure` FAIL. Similar direct-close paths occur in vector/history services. | Repeated failures exhaust the pool until process restart. Add a pool discard operation that closes and releases exactly once; test rollback, cursor-close and reconnect paths. |
| F05 / P0 | High, configuration-dependent | `platform/connectors.py:48-59` accepts `https://127.0.0.1/private` and `https://169.254.169.254/latest/meta-data` outside CF with no allowlist. Both rejection probes FAIL; no actual request sent. CF requires a hostname allowlist, but there is no resolved-IP/private-range validation or DNS pinning. | Add explicit production-mode policy, address classification at connection time and DNS-rebinding defenses. Same-origin and redirect rejection already exist and have unit coverage. Do not assume those solve private-host access. |
| F06 / P1 | High, development-only | `xsuaa.py:86-139` accepts any `dev-token-...` bearer prefix and supplies Admin scopes when APP_ENV is development, VCAP_APPLICATION absent and a minimally complete binding exists. Unsigned-token rejection probe FAIL. Production/CF guard exists. | An exposed default development server is not a protected deployment. Require an explicit disabled-by-default dev-auth opt-in and bind development listeners appropriately. This is not evidence of a production XSUAA signature bypass. |
| F07 / P1 | High | `services/analytics_engine.py:39-46` casts fractional Decimal to float. `9007199254740992.01 + 0.01` expects `9007199254740992.02`, response becomes `9007199254740992.0`. Probe FAIL. | Financial result loses cents at the API boundary. Serialize exact decimal strings or a documented fixed-precision representation; reconcile frontend formatting with it. |
| F08 / P1 | Medium | `services/dataset_service.py:189-199` preserves `=1+1` unchanged in `_excel_export`; `excel_formula_neutralized` FAIL. The edited-workbook save path passes this frame to Excel export. | User-controlled spreadsheet text can become a formula in exported workbooks. Preserve literal cells safely and test XLSX cell types and CSV export consumers. No formula payload was executed. |
| F09 / P0 | Critical advisory ratings; reachability unverified | Registry scans: frontend 5 affected packages (4 high, 1 low); router 23 (1 critical, 13 high, 3 moderate, 6 low); HDI deployer 1 critical. Python reports 22 advisory records across cryptography 44.0.3 and pip 25.0.1, with duplicate IDs. See dependency JSON. | Triage direct/transitive/runtime/build exposure and patched versions; regenerate locks in a controlled change. Backend requirements constrain cryptography below 45, while scanner fix versions exceed that range. pip findings concern environment/tooling, not an imported API feature. |
| F10 / P1 | High, product integrity | `frontend/src/screens/ReportsLibrary.tsx:49-53` constructs a text Blob using title/date and the literal `Status: Verified Compliant Tier-1 Audit`; it performs no dataset/report API call. Source inspection executed; data-backed report generation NOT IMPLEMENTED. | Downloaded files assert unsupported compliance. Remove assertion, label templates accurately, and implement traceable reports backed by selected dataset/version/results. |
| F11 / P1 | High | `.gitignore:17` ignores `mta.yaml`; `git ls-files mta.yaml` has no output. Local deployment script invokes `mbt build` and local manifest includes production review/chat permissive settings. | A clean checkout lacks its required deployment manifest. Track a sanitized manifest and keep only secret values in private bindings/extensions. Local ignored configuration is not audited-commit deployment evidence. |
| F12 / P1 | High regression gate | `frontend/src/__tests__/platform.test.tsx:381` and seven other cases fail in the existing frontend suite. Three generated-dashboard preview cases cannot find `800,000`; five Graph Studio cases cannot find expected widgets/buttons. Source areas include `GraphStudio.tsx:379-458,665-680`. | Restore component/API/context expectations. Root cause may involve fixtures as well as UI behavior; these test failures alone do not establish a live-backend outage. Do not weaken assertions to hide them. |
| F13 / P1 | Medium | `backend/api/routes/datasets.py:340` calls undefined `logger` in the recommendation-retry exception handler; Ruff F821. Static check FAIL; runtime exception branch not separately executed. | Original recommendation failure can be masked by NameError. Define the logger and add an isolated failure-path regression. |
| F14 / P1 | Medium | `routes/semantic.py:177-189` discovery/preview read the entire upload with `await file.read()`; `routes/upload.py:19-31` bounds only the main upload path. Source inspection verified the inconsistency. | Apply shared limits to all upload endpoints, decompressed workbook limits and parser resource budgets. Large malicious payload tests not attempted. |
| F15 / P1 | High operational risk | `platform/connections.py:19-51` reads a root `.env` independently, creates a local `.credential_key` if needed, and silently tolerates persistence errors. Fernet encryption itself passes unit checks. Rotation/restart/replica behavior NOT TESTED. | Require a stable managed key in deployed environments and fail closed; test rotation across API/worker replicas. No actual credential loss/exposure was demonstrated. |
| F16 / P1 | High correctness gap | `models/query_plan.py:47-60` dynamic Join has no right-version field; `services/analytics_engine.py:396` uses right entry currentVersion; `join_service.py:62-76` pins only the selected dataset. Reviewed relationships do carry right version/revision. | Dynamic historical queries can mix versions. Require explicit versions for both sides. Source-verified implementation gap; mixed-version runtime reproduction remains NOT TESTED. |
| F17 / P1 | High deployment gap | `routes/health.py:9-20` returns a degraded JSON payload; `app.py:74` root is unconditional success and local CF uses `/` for health. No separate readiness gate or route rate limiter found. | Implement dependency-aware readiness, distinguish it from liveness, and add bounded request/ingestion/model quotas. Actual CF traffic behavior not executed. |
| F18 / P2 | Low-to-medium maintainability | Ruff check reports 1,697 diagnostics; format check would reformat 133 files. Duplicates and import cycles listed in inventory. | Establish repository-owned lint configuration, remove dead/duplicate paths after reachability checks, and pin CI tools; handle security/correctness findings first. |

## 6. Numerical correctness and joins

Controlled Amount values: `[0.10, 0.20, -0.05, null, 2.00]`. Independently expected and actual local results: SUM **2.25**; AVG **0.5625**; MIN **-0.05**; MAX **2**; COUNT(Amount) **4**; COUNT DISTINCT **4**; COUNT(*) **5**. Filter Team=A returns **0.30**. Group/sort/limit selects Team=B with **1.95**. Temporal monthly aggregation returns January **5**, February **1**. `1 / 4 * 100` returns **25**; zero denominator returns null. Formula calls/imports are rejected. See each expected/actual pair in [consolidated probes](../../audit-results.json).

Internal Decimal summation passes; output precision fails for sufficiently large fractional values. No multi-currency conversion capability was established; a `%` formula passing does not demonstrate exchange-rate or currency accounting correctness. Reviewed relationship tests cover uniqueness rejection. Dynamic join expansion and null matching fail. General many-to-many semantics, all composite-key topologies and historically pinned right-side execution have not been exhaustively tested.

Each domain's independently specified total is **50**, and its controlled published KPI is reconciled against independently calculated aggregate/count expectations. No arithmetic success is inferred from generated prose or mocked provider totals.

## 7. Three agents and multi-domain results

| Domain | Offline inferred label | Rows | Expected / actual SUM | Fallback suggestions | Chart kinds | HTTP flow |
|---|---|---:|---:|---:|---|---|
| Sales and Retail | Sales And Retail | 6 | 50 / 50 | 6 | bar, kpi, line | PASS |
| Healthcare Operations | Healthcare Operations | 6 | 50 / 50 | 6 | bar, kpi, line | PASS |
| Human Resources | Human Resources Operations | 6 | 50 / 50 | 6 | bar, kpi, line | PASS |
| Financial Operations | Financial Operations | 6 | 50 / 50 | 6 | bar, kpi, line | PASS |
| Manufacturing | Manufacturing Operations | 6 | 50 / 50 | 6 | bar, kpi, line | PASS |
| Supply Chain and Inventory | Supply Chain And Inventory | 6 | 50 / 50 | 6 | bar, kpi, line | PASS |
| Education | Education Operations | 6 | 50 / 50 | 6 | bar, gauge, kpi, line | PASS |
| IT Service Management | IT Service Management | 6 | 50 / 50 | 6 | bar, kpi, line | PASS |
| Project Portfolio Management | Project Portfolio Management | 6 | 50 / 50 | 6 | bar, kpi, line | PASS |
| E-commerce | E Commerce Operations | 6 | 50 / 50 | 6 | bar, kpi, line | PASS |


The generated workbook binaries were removed during cleanup. Their generation source is embedded in `audit-results.json`; each workbook contained Facts and Lookup sheets, identifiers with leading zeros, a domain-specific measure and dimension, missing values, a negative fact, a date field and sparse ambiguous `x` values appearing after the first five rows. The parser preserves six facts. Agent 2's LLM is disabled; tests assert identifier/measure/dimension roles and nonempty fallback domain, not independent discovery of a hidden domain. Providing a descriptive filename makes domain-label accuracy easier and must not be confused with domain-blind evaluation.

For all ten HTTP cases, real local routes execute against isolated temporary services: upload, propose/revise semantics, reject execution before semantic approval (409), approve, calculate 50, propose definitions, reject unapproved publication (409), approve/publish (200), fetch/reconcile dashboard and reupload to version 2 while retaining version 1. Authentication, HANA writes and embeddings are substituted. The update repeats the same facts; complete recalculation after changed data remains NOT TESTED. Lookup-sheet joins were not exercised separately in each domain. Unusual-date scenarios have existing standalone locale/header coverage, not a complete per-domain matrix.

Workflow persistence and error/retry tests pass locally, including failed storage blocking publication and retrying saved versions. Default auto-approval conflicts with enterprise review requirements even though strict-mode tests pass. No calibrated semantic confidence field exists. First-five-row inference bias and ambiguous-schema quality remain NOT TESTED; successful sparse ingestion does not establish semantic accuracy on sparse fields.

## 8. HANA, transactions and historical versions

**All 18 real-cloud HANA requirements are BLOCKED**, including authentication/TLS, pool behavior against a server, schema discovery/table creation, parameter binding, transactions, vectors/cosine similarity, concurrent operations, reconnect, migrations, cascade deletion and query plans/performance. No production connection was attempted.

Local unit equivalents passed for parameterized discovery, quoted identifiers, bounded pool creation, failed connection creation, vector replace rollback, dimension shaping, scoped vector query construction, cascade orchestration and isolated metadata compare-and-swap. The new metadata failure probe exposes a permit leak not caught by the existing creation-failure test. Generated SQL or mocked transactions do not establish SAP syntax/engine/DDL compatibility. `REAL_VECTOR(1536)` is declared and embedding projection is configured at `dataset_service.py:611-614`; model compatibility and quality require real-provider testing.

Local version evidence includes full replacement, append/upsert, unchanged/changed/deleted counts, key-only deletion events, idempotency receipts, stale-editor rejection, schema hashes, semantic revisions, rollback, failed object-write nonpublication, chunk reuse, concurrent monotonic local version allocation, retention/pruning and cascade deletion regressions. Added history test verifies original total **30**, replacement total **300**, version-1 original rows, repeated receipt returning version 2, and restore to version 1 with both versions retained.

Logical historical data is preserved locally; asynchronous indexing can update a version's index manifest/status, so byte-for-byte immutability of all version metadata is not claimed. Deletion events are handled as row removal plus aggregate provenance counts; a per-key tombstone ledger is absent. Historical dashboards, live historical vectors/RAG, full partial-object cleanup and HANA concurrent version creation remain unverified. Runtime full-replacement/append does not automatically prove schema-change acceptance or safe cross-table historical querying.

## 9. RAG and AI evaluation

[consolidated Evaluation cases](../../audit-results.json) contain nine known-answer cases: six scalar natural-language aggregates over Amount, an unsupported forecast, an unknown field and an instruction-like credential request. **9/9 local deterministic planner cases match their independently specified answers or return no plan.** This is planner/executor evidence, not a RAG correctness score or an end-to-end answer/refusal evaluation.

Real embedding generation, relevance, citation precision, multi-turn model context, stream token timing, token accounting accuracy, provider timeout/retry recovery, prompt-injection resistance and historical retrieval are BLOCKED. Citation precision is explicitly **null**, not zero or 100%. Existing tests exercise synthetic source filtering, record-ID boundaries, session ownership, deterministic answers that avoid vector totals, and streaming/error handling. There is no provider-backed evaluation dataset with scored source citations in this audit. Retrieved text and first-five-row samples enter prompts; prompt instructions alone do not establish injection resistance.

## 10. Connectors

| Service | Implementation | Real environment | Local evidence |
|---|---|---|---|
| REST | HTTPAdapter | BLOCKED | Next links, mapping, cross-origin/redirect rejection, failure/redaction cases |
| SOAP | SOAPAdapter, zeep | BLOCKED | Explicit operation mapping; DTD/entity restrictions; stand-in transport close |
| OData v2/v4 | ODataAdapter | BLOCKED | Metadata, pagination, delta/deletion mapping contracts |
| S/4HANA | S4HANAAdapter | BLOCKED | Configured entity adapter only; no live SAP business API evidence |
| SAP Analytics Cloud | SACAdapter | BLOCKED | Provider/export path adapter; no real export execution |
| HANA Cloud | HANAAdapter | BLOCKED | Quoted/parameterized discovery and batched cursor stand-in |
| S3 / GCS / Azure Blob | ObjectAdapter | BLOCKED | Bytes/ETag/generation/checkpoint identity using stand-in SDKs |

All ten adapters are present; none is established production-functional. OAuth/basic/bearer/API-key and provider SDK auth modes exist. Fernet credential storage and immutable credential references have unit evidence. Provider credential rotation and revocation, quotas, pagination interruption/resume and long-running incremental synchronization are not verified. HTTP calls have timeouts and do not follow redirects, but no adapter-level rate-limit retry/backoff loop was found; job-level retries restart operations. REST/HANA full snapshots are not general incremental checkpoints. OData delta and object ETag checkpoints do not prove every provider's update/deletion semantics.

## 11. Frontend and product honesty

Seventeen frontend test files execute: **15 pass, 2 fail**. Failures are five Graph Studio navigation/recommendation/review cases and three generated-dashboard preview cases. Passing tests cover selected auth refresh/context, logout activity cleanup, SSE parsers, dataset services, temporal sort, source metadata, widget sections, Data Explorer skeleton, ingestion cockpit, sidebar and HANA view components. Tests use happy-dom and mocked network responses.

All twelve requested screen source files exist. That is not evidence that every loading/empty/success/error/recovery state works. Real-browser login/logout/unauthorized navigation, keyboard and screen-reader accessibility, responsive layouts, chart pixels, connectivity recovery and full HANA administration are NOT TESTED or BLOCKED. Reports Library is a static template download and does not implement the requested enterprise report behavior. No blanket frontend PASS is issued.

Bearer tokens are stored in both sessionStorage and localStorage (`services/api.ts:18-23`); DOMPurify is used by MarkdownRenderer. These are source observations. Persistent token exposure under XSS, complete CSRF behavior through App Router and the broad SAP-origin CORS regex have not received a browser security exercise. Secret scanning found no matching committed secret indicators among 747 distinct reachable blobs across 16 commits; this pattern-based result does not certify the absence of credentials or sensitive records.

## 12. Performance and concurrency

| Rows | Threads | Samples | p50 ms | p95 ms | p99 ms | Queries/s | Errors | CPU s | Frame bytes |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 1 | 5 | 2.10 | 2.57 | 2.65 | 453.71 | 0% | 0.016 | 8,132 |
| 10,000 | 1 | 5 | 18.65 | 33.40 | 36.26 | 44.81 | 0% | 0.078 | 80,132 |
| 100,000 | 1 | 5 | 208.39 | 243.56 | 246.58 | 4.63 | 0% | 0.922 | 800,132 |
| 1,000,000 | 1 | 5 | 2058.79 | 2528.61 | 2569.60 | 0.47 | 0% | 8.953 | 8,000,132 |
| 1,000 | 1 | 1 | 3.25 | 3.25 | 3.25 | 72.68 | 0% | 0.000 | 8,132 |
| 1,000 | 10 | 10 | 2.25 | 7.00 | 9.77 | 93.08 | 0% | 0.031 | 8,132 |
| 1,000 | 25 | 25 | 2.55 | 3.52 | 3.67 | 45.44 | 0% | 0.094 | 8,132 |
| 1,000 | 50 | 50 | 2.65 | 3.74 | 11.07 | 77.35 | 0% | 0.141 | 8,132 |
| 1,000 | 100 | 100 | 2.45 | 3.47 | 7.91 | 71.65 | 0% | 0.391 | 8,132 |


All measured queries assert the scalar SUM equals the synthetic row count. These are **in-process pandas queries**, not authenticated users, HTTP throughput, HANA query plans, ingestion benchmarks or RAG/model service performance. The size runs have five observations each; threaded runs have one task per thread, so p95/p99 are interpolated small-sample descriptions and cannot establish stable tail-latency SLOs. Threads are CPU/GIL/scheduler dependent. Cold imports are excluded. Other audit commands ran on the same workstation, limiting comparability.

CPU seconds are process CPU time consumed during each batch; dataframe bytes measure the input frame only. Process RSS, peak allocation, long-term memory growth, sustained CPU utilization and whole-service resource use were not measured. Concurrent ingestion/RAG, dashboard refresh storms, SSE first-token latency, embedding throughput and production-sized connection saturation remain NOT TESTED/BLOCKED. The local permit leak invalidates any claim that the pool is failure-safe.

## 13. Security scans, CI/CD and deployment

Frontend npm scan: **5** affected package entries (4 high, 1 low). App Router: **23** entries (1 critical, 13 high, 3 moderate, 6 low). HDI deployer: **1 critical** entry. These are package-tree counts, not unique vulnerabilities or proven reachable exploits. Full advisory IDs, chains, ranges and proposed fixes are embedded in `audit-results.json` under `supporting_evidence` for each npm scan.

Python pip-audit reports **22 records** in **2 installed packages**: cryptography 44.0.3 (10 records, 6 unique IDs) and pip 25.0.1 (12 records, 6 unique IDs). Duplicate PYSEC records exist; do not report 22 unique CVEs. This installed-environment scan is distinct from scanning every possible resolution of broad requirements. `pip check` passes dependency compatibility, which does not mean vulnerability-free.

No GitHub Actions workflow was tracked initially. Added [enterprise-local-ci.yml](../../.github/workflows/enterprise-local-ci.yml) runs offline backend tests, compile checks, Python lint/format, frontend typecheck/tests/build and dependency scans with read-only repository permission, timeouts and cancellation. **Hosted CI has not executed.** Existing defects will make it red. The workflow does not inject cloud secrets. Live tests require a separate manually dispatched workflow with a protected test environment and disposable schemas. No approval protection or cloud test success is claimed to have been configured remotely.

ESLint configuration is absent; `npm run lint` is TypeScript. Python requirements are ranges with duplicate manifests; audited installed versions are captured in inventory, but a clean resolver/build reproduction has not been performed. Node lockfiles exist. MTA base manifest is absent from Git, and no mbt/HDI/BTP build or deployment was attempted. Migration SQL and HDI definitions are present, but their alternative PLATFORM_DOCUMENTS/synonym/table paths require an actual isolated HANA compatibility run. Startup verifies chat tables without automatically allowing DDL; failure is logged. Dedicated readiness and graceful shutdown/drain behavior are incomplete/unverified; no worker process lifecycle/restart test was executed.

## 14. Commands executed

| Command | Exit | Status | Evidence |
|---|---:|---|---|
| `python scripts/run_offline_tests.py` | 1 | BLOCKED | [consolidated output](../../audit-results.json) |
| `backend/api/venv/Scripts/python.exe scripts/run_offline_tests.py` | 0 | PASS | [consolidated output](../../audit-results.json) |
| `npm test --prefix frontend -- --reporter=verbose` | 1 | FAIL | [consolidated output](../../audit-results.json) |
| `npm run lint --prefix frontend` | 0 | PASS | [consolidated output](../../audit-results.json) |
| `npm run build --prefix frontend` | 0 | PASS | [consolidated output](../../audit-results.json) |
| `backend/api/venv/Scripts/python.exe docs/audits/run_local_probes.py` | 1 | FAIL | [consolidated output](../../audit-results.json) |
| `backend/api/venv/Scripts/python.exe docs/audits/run_static_inventory.py` | 0 | PASS | [consolidated output](../../audit-results.json) |
| `npm audit --prefix frontend --json` | 1 | FAIL | [consolidated output](../../audit-results.json) |
| `npm audit --prefix router --json` | 1 | FAIL | [consolidated output](../../audit-results.json) |
| `npm audit --prefix backend/db --json` | 1 | FAIL | [consolidated output](../../audit-results.json) |
| `backend/api/venv/Scripts/python.exe -m pip check` | 0 | PASS | [consolidated output](../../audit-results.json) |
| `python -m pip_audit --path backend/api/venv/Lib/site-packages --format json --output docs/audits/evidence/python-dependency-audit.json` | 1 | FAIL | [consolidated output](../../audit-results.json) |
| `python -m ruff check --isolated backend/api backend/tests scripts --output-format json --output-file docs/audits/evidence/python-lint.json` | 1 | FAIL | [consolidated output](../../audit-results.json) |
| `python -m ruff format --isolated --check backend/api backend/tests scripts` | 1 | FAIL | [consolidated output](../../audit-results.json) |
| `backend/api/venv/Scripts/python.exe -m compileall -q backend/api/app.py backend/api/platform backend/api/routes backend/api/services backend/api/database scripts` | 0 | PASS | [consolidated output](../../audit-results.json) |

Audit tool installation used an isolated temporary target rather than changing the application virtual environment. Ruff 0.17.6 and pip-audit 2.10.1 were used; initial unsupported pip-audit options were corrected. Local frontend versions and all Python installed versions are captured in their lockfiles/inventory. New CI is reviewable but is not evidence of a successful hosted run. Evidence normalization changed transcript encoding to UTF-8, without changing test outcomes. Historical command paths may refer to supporting files removed during cleanup; their results and script sources are embedded in `audit-results.json`. The CI workflow no longer references removed audit scripts or evidence directories.

## 15. Remediation and release gates

See [prioritized remediation](../../audit-remediation-plan.md) and [reproduction/runbook](../../audit-runbook.md). P0 fixes address approval/access policy, dynamic join correctness, SSRF trust boundaries and critical dependency advisories. P1 fixes address pool discard semantics, decimals, export formulas, real reports, tracked deployment, upload limits, stable encryption keys, historical right-side pins, frontend failures and readiness/rate budgets. P2 covers lint/config/duplicate cleanup and calibrated semantic-quality evaluation. P3 covers expanded domain/browser/soak evidence and reproducibility improvements after correctness gates.

The current evidence supports **local implemented functionality with material defects**. It does not support enterprise deployment, compliance claims, unrestricted domain independence or proven production scalability. Unverified work is explicitly retained in the matrix rather than converted into a mock-backed success.
