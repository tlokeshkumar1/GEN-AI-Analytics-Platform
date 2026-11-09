# API Reference

All application endpoints use `/api`. Local FastAPI: `http://localhost:8000`. Vite on `http://localhost:3000` proxies API requests to FastAPI. In Cloud Foundry, use the App Router URL, whose API route requires Member or Admin scope and forwards the user's token.

Interactive backend references: [Swagger UI](http://localhost:8000/docs) and [ReDoc](http://localhost:8000/redoc). See [setup](setup.md) and [deployment](deployment.md) for configuration.

## Endpoint index

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | HANA connection and AI Core configuration indicators |
| GET | `/api/auth/me` | Current user profile |
| POST | `/api/auth/login` | Legacy token or credential login |
| POST | `/api/auth/sso` | Legacy SAP token or credential login |
| POST | `/api/auth/logout` | Remove token from backend session cache |
| GET | `/api/dashboard` | KPIs and chart series |
| POST | `/api/analytics` | Dataset aggregation and generated SQL display |
| POST | `/api/chat` | Chat reply with persisted history |
| POST | `/api/chat/stream` | Chat with server-sent processing and token events |
| GET | `/api/chat/sessions` | Current user's sessions |
| GET | `/api/chat/sessions/{session_id}` | Session messages |
| DELETE | `/api/chat/sessions/{session_id}` | Delete an owned session and its messages |
| POST | `/api/graph/generate` | Generate a PNG visualization |
| POST | `/api/upload` | Replace the local sales dataset |
| GET | `/api/users` | Administrator-only project user directory |

## Health and authentication

Health returns `status`, `app_name`, `version`, `hana_connected`, and `ai_core_connected`. Currently `status` is always `healthy`; the AI Core flag checks for a configured client ID, rather than making an upstream request. It does not report NVIDIA availability.

The profile endpoint requires a Bearer token at the backend and returns `user_id`, `email`, `name`, `scopes`, `role`, and `roles`. The App Router supplies that token for deployed browser sessions. Admin takes precedence when both roles are present.

Legacy login accepts `ias_token`, or `email` and `password`, with optional `rememberMe`. SSO accepts `ias_token`, or `universal_id_or_email` and `password_or_passcode`, with optional `provider`. Success responses contain `status`, `token`, and `user`. Credential login depends on the configured OAuth service permitting password grants. The deployed frontend uses hosted SAP sign-in through the router.

Backend logout clears the token cache entry. Ending the deployed browser session additionally requires navigating to the router's `/logout`, which redirects to `/logged-out.html`.

Implementation note: the profile route is registered in both health and auth routers; the health router is included first. Profile and legacy login code decode JWT claims without cryptographic verification. The user directory separately verifies tokens with `sap-xssec`; router authentication provides the deployed access boundary for other application routes.

## Dashboard and analytics

Dashboard returns `kpis`, `revenue_trend`, `region_breakdown`, `country_breakdown`, `category_breakdown`, `quarterly_performance`, and `top_products`. KPI items contain `title`, `value`, `change`, and `trend`. The current service reads the cached spreadsheet.

Analytics accepts:

```json
{
  "query": "Show total sales revenue by region",
  "chart_type": "auto"
}
```

Responses contain `query`, `generated_sql`, `results`, `summary_insights`, `recommended_chart`, `insights`, `parsing_latency`, `hana_latency`, `records_scanned`, and `sql_determinism`.

The active service aggregates with Pandas and synthesizes SQL referencing `"NEOVATIC_DB"."SALES_FACT"` for display; it does not execute that SQL in HANA. The route currently ignores the requested `chart_type`. Empty or unsupported aggregations can return built-in example results. Latency/determinism fields are illustrative calculations/constants, rather than measured HANA execution statistics.

## Chat and history

Both chat endpoints accept:

```json
{
  "message": "What was the gross margin in North America?",
  "session_id": "session_123",
  "top_k": 5
}
```

Optional fields are `user_id` and `stream`. Defaults: `session_id: "default"`, `top_k: 5`, `stream: false`. Streaming is selected by calling the stream endpoint; the flag does not switch the ordinary route.

Ordinary chat returns `reply`, `sources`, and `session_id`, plus optional `graph_image`, `chart_type`, `insights`, and `intent`. It saves the user message, loads up to ten recent messages, runs the hybrid pipeline, and saves the assistant response in HANA.

The stream route returns `text/event-stream`. Frames use JSON `data:` lines with event kind in the JSON `type` field:

```text
data: {"type":"request_started","session_id":"session_123"}

data: {"type":"final_answer","content":"The completed answer."}

data: {"type":"result","data":{"reply":"The completed answer.","session_id":"session_123"}}

data: {"type":"request_completed"}

```

Intermediate `stage` and `token` events provide processing/text updates. After 15 seconds without an event, the server emits a `: heartbeat` comment. The final structured result can include processing steps, sources, query plans, and record counts. Stream failures can arrive as error stage/result payloads after HTTP streaming starts.

History GET routes return arrays of session/message dictionaries. They accept optional `user_id` query parameters. Identity resolution uses JWT claims, then `X-User-Id`, then supplied user ID, then `default_user` for local testing. History reads and deletion check session ownership using that resolved identity. Failed deletion returns HTTP 403; success returns `status: "deleted"` and `session_id`.

## Graph generation

Request:

```json
{
  "prompt": "Show quarterly revenue by product category as a stacked bar chart"
}
```

Response fields: `status`, `prompt`, `image_base64`, `message`; optional `chart_type`, `insights`, `records_matched`, `query_plan`, `records_in_source`, `verified`, and `data_as_of`. Empty prompts return HTTP 400; agent errors return HTTP 500. Temporary Python scripts have a 60-second timeout per subprocess execution.

## Dataset upload

Use `multipart/form-data` with a `file` field. Accepted extensions: `.xlsx`, `.xls`, `.csv`; parsing also depends on installed reader engines.

Uploads are saved under `backend/preprocessing/output/` and replace `SAC_Sales_Preprocessed.xlsx`. CSV is converted to Excel, and dataset caches in the handling process are updated.

Responses contain `filename`, `rows_processed`, `embeddings_generated`, `status`, and `message`. The current service reports row count as `embeddings_generated` but makes no embedding calls or vector inserts. Check `status`: service-handled save/parse failures return an error body with HTTP 200. Invalid extensions return HTTP 400; uncaught route failures return HTTP 500.

## User directory

Requires a valid application end-user token with local Admin scope and directory-read permissions described in [deployment](deployment.md). Responses use `Cache-Control: no-store` and contain `users`, `total`, `source: "xsuaa"`, and an ISO UTC `fetched_at` timestamp.

User fields: `id`, `name`, `email`, `role`, `tier`, `status`, `last_login`, `origin`, `role_collections`. Only direct assignments to the exact configured project Administrator/Member collections are returned; last login can be null.

Errors: HTTP 401 for missing/invalid authentication, 403 for missing administrator/directory permissions, 503 for missing binding configuration, and 502 for upstream directory failures.
## Dataset storage and versions

Dataset management uses the backend as its source of truth. Uploads are saved under
`backend/preprocessing/output/<filename without extension>/`. For example, uploading
`Sales.xlsx` saves `Sales/Sales.xlsx`; the next saved change creates
`Sales/Sales_V2.xlsx`, followed by `Sales_V3.xlsx`. Appends save the complete dataset
with the additional rows. Re-uploading the same filename replaces the current data
with a new complete snapshot. Files named `Sales_V2.xlsx` are treated as updates to
`Sales`. Earlier files remain available for rollback.

Each version has a persistent snapshot containing stable row identifiers, its schema,
source chunks and matching embeddings. `datasets.json` records the selected versions
and the dataset currently used by analytics and RAG. It is updated atomically after
the version files have been written. Files already present directly in the output
directory are imported once into the registry; their original files are retained.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/upload` | Upload multipart `file`; return real row/embedding counts and dataset metadata |
| GET | `/api/datasets` | List persisted datasets, schemas, versions and indexing status |
| GET | `/api/datasets/{id}/data` | Read the selected version with `page`, `pageSize`, `sortField`, `sortDir`, and `search` |
| PUT | `/api/datasets/{id}/rows` | Edit rows using JSON `{ "rows": [...] }`; preserve each row's `__rowId` |
| POST | `/api/datasets/{id}/append/preview` | Parse multipart `file` and report actual rows and schema issues |
| POST | `/api/datasets/{id}/append` | Append a multipart `file` or JSON array in form field `rows` |
| DELETE | `/api/datasets/{id}/rows` | Delete JSON `{ "rowIds": ["stable-row-id"] }` from a new version |
| GET | `/api/datasets/{id}/versions` | List saved versions and the current version number |
| POST | `/api/datasets/{id}/rollback` | Restore JSON `{ "version": 1 }` for analytics and RAG |
| POST | `/api/datasets/{id}/activate` | Choose this dataset's current version for analytics and chat |
| POST | `/api/datasets/{id}/reindex` | Refresh embeddings and retry HANA synchronization for the current version |
| DELETE | `/api/datasets/{id}` | Remove the dataset from the registry and retrieval; retain files for recovery |

Uploads and mutations activate the changed dataset. Rollback selects an existing
version and its matching embeddings, without deleting newer history. A change made
after rollback uses the next unused version number, so history is never overwritten.
RAG queries use only the active dataset and selected version; previous-version HANA
vectors and query cache entries are excluded. Chat history supplies conversational
context, while the currently retrieved version supplies authoritative data.

Embedding requests are batched and unchanged chunks reuse matching vectors. HANA
publishes each dataset version transactionally and retrieval filters by its version
ID prefix. If HANA is unavailable, RAG uses the persisted version embeddings. If the
embedding provider is unavailable, the upload remains saved and current source text
is searched instead. The UI reports `embeddingStatus`, `embeddingCount`, and
`hanaSyncStatus`; it never reports fabricated indexing success. Legacy imports start
with `Pending` indexing; use **Refresh embeddings** to index them.

The output directory must remain on persistent storage when deploying; files and
the registry are local to the backend instance. Multiple API workers sharing that
directory serialize version writes with a file lock. Independently deployed
instances require shared storage for the registry and version files.
