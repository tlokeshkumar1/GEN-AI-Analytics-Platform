
# Code Review: Weaknesses and Priority Changes

Reviewed: 21 November 2026. Scope: current repository implementation.

**Update (22 November 2026):** Code fixes and regression coverage are implemented. After the RAG transcript follow-up, the full backend suite passes **220/220** and frontend suite **47/47**. TypeScript and production build checks passed in the earlier full verification; the follow-up changes only backend code and documentation. Existing business defaults are retained. See [changes, final validation and runtime requirements](code-review-remediation.md). The findings below are the original review record.

The main focus should be **correct analytical results, consistent dataset permissions, and isolated Python execution** before adding more AI or UI features.

P0 = address before production use; P1 = next reliability work; P2 = maintenance.

## P0 — Correctness and access control

### 1. HANA queries omit date filters and bypass semantic checks

- **Evidence:** [analytics_engine.py](../backend/api/services/analytics_engine.py), lines 175–386: SQL builds conditions from `plan.filters` but never applies `plan.date_filter`. Successful HANA execution returns before semantic aggregation checks at lines 413–465.
- **Impact:** A question about January can return an all-time total. An aggregation disallowed by the semantic model can execute through HANA.
- **Change:** Validate fields and permitted aggregations before choosing an execution backend. Compile date ranges into parameterized SQL. Reject unsupported plan features explicitly.
- **Verify:** Run the same date-filtered and forbidden-aggregation plans through HANA and DataFrame paths; require equivalent results or equivalent validation errors.

### 2. Dataset and version resolution can select the wrong data

- **Evidence:** [analytics_engine.py](../backend/api/services/analytics_engine.py), lines 184–209, resolves an entry-level physical table without using the requested snapshot version. [datasets_metadata_repository.py](../backend/api/platform/datasets_metadata_repository.py), lines 296–355, falls back to the table with the most records when matching fails.
- **Impact:** A historical-version request can read a newer physical table; an unresolved dataset can silently read an unrelated table.
- **Change:** Resolve an exact `(workspace, dataset, version)` table mapping. Use the pinned snapshot when necessary. Remove fuzzy/largest-table fallback from execution paths and return an explicit error when no exact mapping exists.
- **Verify:** Select v1 while v2 exists; also request a missing table. Confirm v1 remains stable and the missing mapping fails.

### 3. Dataset permissions differ between chat and other screens

- **Evidence:** [execution_context.py](../backend/api/models/execution_context.py), `require_dataset_access()`, returns before checking reader/writer grants when `for_chat=True`. [upload_service.py](../backend/api/services/upload_service.py), lines 111–121, defaults empty reader grants to `["*"]`. [graph.py](../backend/api/routes/graph.py), lines 109–117, switches to a body-supplied dataset using a raw catalog lookup without rechecking its grants and substitutes a `system` context.
- **Impact:** Restricting a dataset in the access-management UI does not consistently restrict chat or graph access.
- **Change:** Apply one authorization policy to every read path. Revalidate body-selected datasets, preserve the authenticated identity, and make workspace-wide sharing explicit. If workspace-wide chat is intentional, expose and document that policy.
- **Verify:** A Member without grants must receive the same denial from data, chat, graph, join, and retrieval endpoints.

### 4. A graph route runs generated Python on the API host

- **Evidence:** [python_graph_agent.py](../backend/api/services/python_graph_agent.py), lines 1292–1315, invokes generated scripts with `subprocess.run()` and no explicit environment or resource isolation. `/api/graph/python-agent/generate` reaches this path. An isolated container implementation already exists in [custom_charts.py](../backend/api/platform/custom_charts.py).
- **Impact:** The child process inherits the API environment and host permissions. AST filtering and a timeout do not provide an operating-system security boundary.
- **Change:** Route every generated-code execution through the isolated worker; disable host execution in production. Pass only approved data, remove credentials, and enforce CPU, memory, network, output-size, and duration limits.
- **Verify:** Generated code cannot read host secrets, contact the network, or exceed worker limits.

## P1 — Reliability and data quality

### 5. SQL identifier handling and join resolution need a shared validator

- **Evidence:** [query_plan.py](../backend/api/models/query_plan.py) accepts unrestricted strings for table, field, alias, and join-key names. [analytics_engine.py](../backend/api/services/analytics_engine.py), lines 229–289, interpolates identifiers into SQL. `qualify_col()` prefers the right table when both tables contain the same column.
- **Impact:** Ambiguous names can aggregate the wrong column; unsafe identifier strings are not consistently rejected. Value parameters alone do not protect SQL identifiers. Exploitability was not tested.
- **Change:** Resolve identifiers from authorized dataset schemas, quote them centrally, and require explicit table qualification for ambiguous columns. Do not accept arbitrary physical tables from a client plan.

### 6. Upload success can hide failed persistence and automatic approval

- **Evidence:** [upload_service.py](../backend/api/services/upload_service.py), lines 141–148, automatically approves AI semantics; lines 207–220 mark the HANA stage completed after a caught persistence error; the final response still sets `status: "success"` at line 277.
- **Impact:** Users can treat partially ingested data or incorrect AI classifications as ready for governed analytics.
- **Change:** Return distinct failed/partial/ready states, support idempotent stage retries, and gate publication on required persistence steps. Make semantic auto-approval configurable and require review where governance needs it.

### 7. Numerical failures fall through to generative retrieval

- **Evidence:** [pipeline.py](../backend/api/rag/pipeline.py), lines 359–426, sends structured execution failures or empty results into vector retrieval and answer generation.
- **Impact:** A numerical question can receive a plausible explanation without a successful calculation; an empty result is also conflated with execution failure.
- **Change:** Separate `no_data`, `invalid_query`, and `execution_failed`. For numerical requests, return an explicit inability to calculate; never substitute retrieved samples for aggregate evidence.

### 8. Automatic cleaning can change business meaning

- **Evidence:** [agent_preprocessing.py](../backend/api/platform/agent_preprocessing.py), `_normalize_formatted_numbers()` converts numeric-looking strings using `float()` and removes commas; `_remediate_nulls()` replaces string nulls with `Unassigned`; `_normalize_dates()` formats dates as `%Y-%m-%d`.
- **Impact:** Leading-zero identifiers, decimal-comma values, high-precision numbers, missing-value meaning, and time-of-day information can change.
- **Change:** Honor declared semantic types and locale settings; preserve identifiers, nulls, timestamps, and decimal precision. Preview potentially lossy transformations before applying them.

### 9. Execution metadata and sampling can mislead users

- **Evidence:** [analytics_service.py](../backend/api/services/analytics_service.py), line 44, and `AnalyticsResult.to_dict()` hardcode `pandas` even for HANA execution. HANA `records_matched` at [analytics_engine.py](../backend/api/services/analytics_engine.py), line 352, uses group count or total table count rather than filtered source-row count. [excel_dataset_service.py](../backend/api/services/excel_dataset_service.py), line 75, loads only 2,000 rows when falling back to a HANA frame.
- **Impact:** Provenance and matching counts are inaccurate. Calculations consuming the sampled fallback frame may be incomplete.
- **Change:** Record actual backend, selected version, filtered source-row count, and completeness. Keep schema samples separate from calculation inputs; refuse full-data claims for sampled results.

## P2 — Maintenance

- Remove unreachable code after the immediate returns in `RAGPipeline.run()` and `run_stream()` and consolidate the duplicate `_extract_what_if_params()` definitions in [pipeline.py](../backend/api/rag/pipeline.py).
- Replace silent HANA exception fallback with structured error logging and an explicit fallback reason.
- Update [architecture.md](architecture.md): its fixed-spreadsheet and authentication descriptions conflict with current code.
- Add a deployed worker module and monitoring if queued connector/advanced-chart jobs are enabled; [mta.yaml](../mta.yaml) currently defines router, API, and UI modules, while [worker.py](../backend/api/worker.py) is a separate entry point.

## Recommended implementation order

1. Fix date filters, semantic validation, exact version mapping, and authorization.
2. Consolidate Python execution into the isolated worker.
3. Fix upload lifecycle states and numerical failure responses.
4. Preserve source data types and correct provenance/completeness reporting.
5. Add focused regression coverage, then remove legacy code and refresh documentation.

## Validation performed

Read-only code inspection plus an isolated reproduction using the actual `_execute_on_hana()` method extracted from the source, with stubbed database dependencies. A plan containing a January date range generated `SELECT SUM("AMOUNT") AS "amount" FROM "SALES_V2"` with no date predicate. A selection context pinned to version 1 still queried its entry-level `SALES_V2` table.

This confirms those method-level behaviors; it does not establish their frequency in live deployments. No live database/provider calls or full test suites were run. Application code was not changed.
