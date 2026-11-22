# Code Review Remediation

Implemented: 22 November 2026.

## Scope and business compatibility

The fixes retain the existing business formulas, dashboard/KPI workflows, dataset versioning, supported sources, Member/Admin roles, workspace chat policy, and default automatic semantic approval. Existing numerical API values remain JSON numbers. New fields report execution provenance, warnings, completeness and ingestion readiness.

Failures now produce accurate errors/partial states instead of successful but incomplete answers. Historical calculations use their saved data, and arbitrary tables cannot substitute for a missing dataset. These are intentional corrections to defective execution and reporting.

## Changes by finding

| Original finding | Implemented change |
| --- | --- |
| Missing HANA date filters / semantic checks | Fields and aggregation permissions are validated before dispatch. SQL includes parameterized date predicates and literal, case-insensitive textual filters. |
| Wrong table or version | Removed largest-table/fuzzy fallback. Historical requests use snapshots. Table overrides must belong to an authorized selection. Empty snapshots remain empty. Automatic table names include a stable dataset suffix to avoid collisions. |
| Inconsistent permissions | Graph and dashboard body selections use shared authorization and retain user identity. Chat sharing is an explicit policy; nonchat requests cannot borrow it. Vector retrieval remains limited to authorized datasets and requested versions. |
| Host Python execution | Generated graph code uses the existing isolated container executor. The dashboard's application-owned plotting template renders directly without interpolating user text into executable scripts. |
| Identifier / join ambiguity | SQL fields resolve against actual schema and identifiers are escaped centrally. Joins use complete, authorized snapshot DataFrames with stable left-side columns and existing right-side suffixes, instead of the SQL path that silently preferred right-side collisions. Successive joins preserve earlier joins. |
| Misleading upload success | HANA and semantic persistence failures return `partial`, warnings and `ready_for_publication=false`. Failed stages remain visible in the UI. Publication is blocked until required stages are completed. Storage retry reuses the saved version. |
| Generative numerical fallback | Numerical errors and empty results return explicit statuses and do not synthesize aggregate answers from vector chunks. Explanatory chat retrieval remains available. |
| Lossy cleaning | Declared identifiers/types and explicit duplicate policies survive cleaning. Decimal snapshot values retain precision; timestamps retain time information. Ambiguous locale values remain text pending explicit parsing choices. |
| Misleading provenance / sampled totals | Results report actual HANA/DataFrame execution, selected context and filtered input-row counts. Complete DataFrames replace bounded calculation samples; internal database reads can retain native Decimal/timestamp values without changing public JSON defaults. |
| Maintenance / operations | Removed unreachable chat branches and the duplicate simulation parser. Added worker deployment/heartbeat monitoring, an offline test runner and updated architecture documentation. Connector errors no longer echo provider exception text that may contain secrets. |

Successful automatic table provisioning also no longer prevents a reupload from creating the next version of the same dataset. HANA metadata persists the new ingestion state and table provenance across reloads.

## Preserved defaults and optional controls

| Setting | Default | Meaning |
| --- | --- | --- |
| `PLATFORM_CHAT_WORKSPACE_ACCESS` | `true` | Preserve Member chat across their workspace. Set `false` to enforce individual dataset reader grants for chat. Workspace boundaries always apply. |
| `PLATFORM_AUTO_APPROVE_SEMANTICS` | `true` | Preserve first-upload self-service approval. Set `false` to require review before analytics/publication; inferred models and recommended definitions remain proposed. |
| `PLATFORM_CATEGORICAL_NULL_POLICY` | `label` | Preserve the existing `Unassigned` label for missing categorical values. Set `preserve` to retain source categorical nulls. Numeric/identifier/date nulls are preserved. |

No stricter business policy is enabled automatically. Explicit source parsing settings take precedence over cleaning heuristics; automatic duplicate removal remains the default when no parsing plan is supplied.

## Runtime and deployment

Python-requested charts now use controlled Matplotlib and Seaborn templates on the API and existing queue worker. No Docker image, Docker daemon, or `PLATFORM_CHART_IMAGE` setting is needed. AI supplies chart specifications rather than executable code. Only validated fields, aggregations, and filters are used; empty filtered data fails explicitly. Source frames are limited to 100,000 rows, categorical matrices to 50 categories per axis, and standard charts to 200 groups. Unsupported chart types fail explicitly.

Run the queue worker locally with the backend on the Python path:

```powershell
Set-Location backend
python -m api.worker
```

The main MTA's worker module uses the application's HANA and XSUAA bindings. Configure its private AI credentials, model/provider settings and matching `PLATFORM_WORKSPACE_ID` separately. Administrator endpoint `GET /api/system/workers/health` reports workers with heartbeats newer than 90 seconds.

## New recovery API

`POST /api/datasets/{dataset_id}/retry-ingestion?version=N` requires dataset write access and the current version. It retries table persistence from the saved snapshot without allocating a new version. A saved semantic model must exist. Retrying a failed append returns 409 until destination contents are reconciled, preventing duplicate insertion after a partial commit.

## Verification

The regression suite covers date predicates, aggregation permissions, exact versions/table mappings, literal SQL filtering, body-selected access, workspace policies, restricted vector retrieval, complete data loading, source precision, upload readiness/retry, isolated execution and worker health. Existing tests were adjusted where their assertions explicitly depended on the reviewed defects or their fixtures omitted required relational persistence.

```powershell
backend/api/venv/Scripts/python.exe scripts/run_offline_tests.py
npm run test --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
```

`scripts/run_offline_tests.py` disables `.env` loading, external Requests calls and live HANA connections, and uses temporary local storage. Use a Python environment with the backend requirements installed; the path above is this workspace's existing environment.

Final validation after resolving the remaining failures (22 November 2026):

| Check | Result |
| --- | --- |
| New backend regressions | **34/34 passed** |
| Frontend TypeScript | **Passed** |
| Frontend production build | **Passed** |
| Targeted frontend ingestion/dataset/scoping tests | **14/14 passed** |
| Full backend suite | **220/220 passed** after the RAG transcript follow-up, no failures, errors or skipped tests |
| Full frontend suite | **47/47 passed** across all 10 files |
| Patch whitespace validation | **Passed** |

The earlier **169/197 backend** and **46/47 frontend** results are superseded. All reported failing tests now pass, and six additional tests cover admin query behavior, unknown definition references, and directory session/cache handling. The automated checks completed with exit code 0.

The RAG transcript follow-up adds 17 tests for catalog responses, session safety, request-body replay, schema-driven planning, direct result formatting, declared what-if inputs and missing-evidence handling. The frontend suite was rerun and remains **47/47**. See [dynamic RAG chat changes and limits](rag-chat-improvements.md). No external-provider or deployment latency claim is based on these offline checks.

### Follow-up fixes

- Retrieval fallback now includes the actual dataset version in both chunk IDs and metadata; rollback and failed embedding generation cannot mislabel source versions.
- Edited/appended versions inherit the original file format from version metadata, rather than deriving a suffix from the display title. Uploaded filenames are reduced to their basename before deriving display names.
- Async indexing honors the service's configured mode; tests hold indexing behind an event and verify Pending/Indexing followed by Ready. `sync=true` continues to request foreground indexing.
- Dataset deletion returns consistent vector-cleanup fields and records the cleanup outcome instead of unconditionally reporting success for each remote stage.
- SCIM normalization resolves canonical group names, reports configured collection names, validates incomplete/malformed pagination, and handles unknown login timestamps. Directory APIs continue using explicit project login/session maps; global SCIM login times do not replace project session history. Browser responses use `no-store`; server cache entries are copied and can be refreshed. Production code no longer detects mocks to choose a different fetch path, and provider errors do not print credential-bearing exception text.
- Strict-review mode checks row grain and leaves recommended definitions proposed. Publication checks the selected semantic revision and rejects missing or unapproved definition references.
- USD chart values use an explicit formatting locale, so the expected currency display is stable across machines.

### Test setup corrections

HANA admin tests now execute the actual route/service logic and SQL against a local DB-API fixture backed by SQLite, including catalog queries, row counts, sorting, search and pagination. This replaces their dependency on a particular developer database; service responses are not replaced with canned successful responses. Additional cases verify disconnection and Member access denial.

Strict-review scenarios explicitly enable the existing strict policy and create restricted grants. Self-service approval/sharing defaults remain unchanged. The HTTP integration fixture now supplies the same dataset service to the dashboard router as to ingestion and analytics. Numerical tests check the public numeric JSON contract and verify that AI explanations receive computed data. No tests were disabled or marked expected failures to obtain these results.

Live SAP/NVIDIA connectivity, Docker container execution and deployment are not established by mocked/offline tests. Existing stored data that was already rounded or overwritten needs restoration from its original source; these fixes protect subsequent processing. Failed create operations retain create semantics during retry; they never force replacement of an existing destination.
