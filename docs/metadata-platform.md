# Metadata-driven analytics: operation and migration

This change extends the existing FastAPI/React application. Authentication remains SAP XSUAA; chat and embedding providers remain NVIDIA NIM; optional advanced chart code generation remains SAP AI Core. Numerical answers execute validated query plans against immutable dataset snapshots with pandas and Decimal arithmetic. Responses identify that backend; they do not claim SQL or HANA execution.

## User workflow

1. Open **Upload Dataset**, discover the workbook's sheets/tables, choose a header and parsing settings, and preview the import. Duplicate transactions remain by default. Removing duplicates is an explicit choice. Specify ambiguous dates, number separators, currencies, identifiers and units. Original uploaded bytes are retained.
2. Propose a semantic model. Review field meanings, permitted/default aggregations, business domain and row grain. A proposal is not approved automatically. Saving edits creates another semantic revision. Unknown business meaning stays unconfirmed.
3. Approve the model and select its revision in the context bar. Dataset ID, data version and semantic revision travel with every analytics/chat request. The backend supplies the verified user and workspace. Historical versions remain readable; the UI disables historical row editing.
4. Open Graph Studio to propose or build individual KPIs/charts. Preview exact results, edit the definition, then approve or reject each revision. Publish the approved revisions to the dashboard. New uploads do not silently apply old approvals; explicitly reuse definitions only when schema and transformations remain compatible, or review new semantics.
5. Use Data Explorer or chat for approved measures. Numerical questions use the same executor as dashboard widgets. Unsupported/ambiguous questions require clarification. Narrative evidence retrieval is scoped to the selected version and is not a source of whole-dataset totals.
6. **System Management** is the final sidebar entry. Its tabs are Connections, Sync Jobs, AI Configuration, Storage & Retention, and Access & Audit. Data Sources links here for connection administration. Local files remain in Upload Dataset.

Reports and alerts from the original demonstration are hidden unless `VITE_DEMO_MODE=true`. Keep that build flag unset for real data. No operational alert scheduler or saved-report export workflow is provided by this change.

## Local setup

Install backend dependencies from `backend/requirements.txt` (the API-local requirements file contains the same dependencies). Install frontend dependencies from its lockfile using `npm ci`.

From the repository root, configure these development values in the process environment or your existing private environment file:

```dotenv
PLATFORM_WORKSPACE_ID=default
PLATFORM_METADATA_BACKEND=sqlite
PLATFORM_DATASET_BACKEND=durable
PLATFORM_OBJECT_BACKEND=local
# Optional absolute overrides; otherwise backend/preprocessing/output is used:
# PLATFORM_METADATA_PATH=C:/analytics-dev/metadata.sqlite3
# PLATFORM_OBJECT_ROOT=C:/analytics-dev/objects
# PLATFORM_CREDENTIAL_KEY=<Fernet key supplied through a secret manager>
MAX_VERSIONS_PER_DATASET=0
```

The existing SAP authentication and provider environment settings still apply. Never place secrets in frontend variables. Connector credentials entered in System Management are encrypted with `PLATFORM_CREDENTIAL_KEY`; missing encryption configuration fails explicitly. Preserve the key separately from database backups. Key rotation/re-encryption requires an operator-managed migration and is not automatic.

Start the API and a separate job worker from `backend`:

```powershell
python -m uvicorn api.app:app --host 127.0.0.1 --port 8000
# In a second terminal with the same environment and working directory:
python -m api.worker
```

From `frontend`, run `npm run dev`. The existing development proxy routes `/api` requests. A root-level worker alternative is `python scripts/run_jobs.py`; `--once` processes at most one available job.

`PLATFORM_DATASET_BACKEND=durable` uses the same durable repository/job path locally and in production. Without that setting, local legacy catalogs continue to work with the original background index threads; those development threads do not survive API restarts. Do not use that mode to validate worker recovery. The SQLite and local object adapters are for development/testing; Cloud Foundry refuses them for production persistence.

## Production configuration

Prepare configuration and run migrations in a separate reviewed deployment. This coding change does not deploy resources or run production DDL.

| Setting | Required behavior |
|---|---|
| `PLATFORM_WORKSPACE_ID` | Server-owned workspace identifier; client workspace overrides are rejected. Separate deployment/configuration is required for another workspace. |
| `PLATFORM_METADATA_BACKEND=hana` | Existing HANA binding and configured application schema. |
| `PLATFORM_DATASET_BACKEND=durable` | Transactional metadata catalog and immutable object manifests. Automatically selected under Cloud Foundry. |
| `PLATFORM_OBJECT_BACKEND` | `s3`, `gcs`, or `azure_blob`. |
| `PLATFORM_OBJECT_BUCKET` | Bucket or Azure container for application artifacts. |
| `PLATFORM_AZURE_ACCOUNT_URL` | Azure application artifact account URL when Azure is selected. |
| `PLATFORM_CREDENTIAL_KEY` | Stable Fernet encryption key from a secret manager. |
| `CONNECTOR_ALLOWED_HOSTS` | Comma-separated exact host allowlist for HTTP/SOAP endpoints. Required in Cloud Foundry. |
| `PLATFORM_CHART_IMAGE` | Optional prebuilt isolated Python chart image available to the separate worker runtime. |

Application artifact SDKs use the runtime's managed credentials: AWS credential chain, Google application default credentials, or Azure DefaultAzureCredential. Connection-specific source credentials are encrypted separately. Source connection storage and application artifact storage are independent configurations.

The new metadata table is defined in `backend/db/src/schema/platform_documents.hdbtable` for HDI and in `backend/db/migrations/001_platform_metadata.sql` for an explicit schema migration. Choose the deployment-appropriate method; do not apply both blindly. Existing vector/history tables must remain accessible through the configured schema. Application startup does not create production tables.

Run a dedicated worker process with the same HANA, object storage, credential key and workspace configuration as the API. The worker entry point is packaged inside `backend/api/worker.py`; the existing web Procfile remains unchanged. Jobs use persisted state, compare-and-swap claims, dataset leases, heartbeats and idempotency receipts. A dead worker can be recovered after lease expiration. Cancellation is cooperative between batches/stages; an already committed dataset version is preserved. A binding checkpoint advances only after dataset commit. Failed indexing does not fabricate data readiness or successful provider status.

Retention defaults to keeping all versions. A positive version limit is applied on later writes; versions referenced by semantic models are protected. Content-addressed object bytes are retained even after catalog pruning. Object garbage collection, backup retention, legal hold and large-scale storage lifecycle policies require explicit operational tooling; no automatic deletion of raw object storage is performed.

## Connector configuration

Each connection records provider, service, protocol and authentication independently. Only real successful provider tests produce a verified status. Save/test/discover/preview/sync failures are returned as failures, with credentials omitted. Production HTTP is HTTPS and same-origin pagination; SOAP WSDL/service requests also stay on the configured origin. `CONNECTOR_ALLOW_HTTP=true` is an explicit development-only relaxation.

| Service | Public configuration | Supported source behavior |
|---|---|---|
| REST | `base_url`, `records_path`, `pagination` (`none`, `next_link`, `page`, `offset`), optional page parameter configuration | Paginated flat records; one binding selects a source path. |
| OData | `base_url`, optional `incremental` | Metadata entity discovery; V2/V4 paging and explicit delta links. OData deletion payloads require explicit `deletion_mapping` (target key to source path) and `deletion_field`; incremental bindings require upsert. Arbitrary nested payloads are rejected or flattened using explicit `response_mapping`. |
| SAP S/4HANA | `base_url`, `api_service` | Published service-specific OData API. Availability/authorization depends on the tenant. |
| SAP Analytics Cloud | `base_url`, `namespace`, `provider_id` | Data Export provider discovery and FactData/MasterData/AccountMaster sources; not an arbitrary SAC URL adapter. |
| SOAP | `base_url`, WSDL/operation configuration | Zeep WSDL discovery and named operations; map returned records explicitly. |
| HANA | `host`, `port`, database `schema` and source table | Quoted identifiers, schema/table discovery and batched full snapshots. Incremental watermark extraction is not implemented. |
| S3 | `bucket`, optional `prefix`, `region` | One CSV/Excel object per binding, paginated discovery, ETag checkpoint. |
| GCS | `bucket`, optional `prefix`, `project` | Generation-conditioned file download and ETag checkpoint. |
| Azure Blob | `account_url`, `bucket` (container), optional `prefix` | Conditioned file download, ETag checkpoint and managed/key/SAS authentication. |

Authentication choices are returned by `/api/system/connector-types`. HTTP services support none, basic, bearer, API key and OAuth client credentials; object services support their corresponding managed and key identities. Secrets belong in the password fields or `credentials` API object, never in public configuration URLs or JSON. A connection can be saved before it has been tested; that is not a claim that the source works.

Append/upsert bindings require an existing target dataset. Upsert requires explicit unique non-null source keys; row hashes are not update identities. Deletion flags must be booleans, and key-only deletion events are accepted. Incoming schema/type changes fail review before publication. Duplicate policy is explicit. Empty schema-less provider responses do not replace an existing dataset silently. Sync is manually triggered by persisted jobs; recurring scheduling is not implemented.

Provider documentation: [OData](https://www.odata.org/getting-started/basic-tutorial/), [S3 pagination](https://docs.aws.amazon.com/boto3/latest/reference/services/s3/client/list_objects_v2.html), [Zeep transports](https://docs.python-zeep.org/en/latest/transport.html), [SAC Data Export](https://help.sap.com/docs/SAP_ANALYTICS_CLOUD/14cac91febef464dbb1efce20e3f1613/4e4f683c8b4346e184dee6b7647af1a1.html?locale=en-US).

## Query and semantic contracts

Query plans are strict Pydantic objects: approved measures and aggregations; dimensions; literal filters; date ranges/time grouping; sorting/limits; reviewed relationship IDs; reviewed derived metrics; explicit current/previous period ranges. Unknown fields, ambiguous aliases, unsupported filters and unauthorized relationships fail closed. Financial values are serialized as decimal strings, counts as integers, and missing values as null. Display rounding belongs to the view; source snapshots retain their parsed precision. Python Decimal calculations use 38-digit working precision; arbitrary unbounded precision is not claimed.

Derived metrics use an arithmetic AST with named aggregate dependencies. Example semantic definition:

```json
{
  "name": "MarginPercent",
  "expression": "profit / revenue * 100",
  "dependencies": {
    "profit": {"field": "Profit", "aggregation": "SUM"},
    "revenue": {"field": "Revenue", "aggregation": "SUM"}
  },
  "description": "Ratio of total profit to total revenue",
  "unit": "%"
}
```

Division by zero or missing dependencies returns null. No calls, arbitrary Python, SQL or power expressions are permitted. Relationships pin `right_dataset_id`, `right_version`, `right_semantic_revision`, `left_keys`, `right_keys`, and `cardinality` (`many_to_one` or `one_to_one`). Validation measures uniqueness/coverage and rejects joins that multiply facts. Many-to-many joins require a separately reviewed transformation/bridge dataset.

Logical Data Engineering, Semantic Modelling and Analytics Planning agents are persisted workflow stages over validated contracts, using the existing services. Conservative deterministic proposals are available without a model. Model-assisted natural-language planning uses the configured NIM service and the query-plan schema. This implementation does not promise autonomous inference of every business formula or an accuracy percentage.

Routine charts render exact query results directly. Advanced generated Python is optional and runs in a separate Docker/OCI container with no network, no application credentials, a read-only filesystem, non-root user, bounded memory/CPU/PIDs/output and a timeout. Build the reviewed image from `backend/chart-worker/Dockerfile` and run the worker on infrastructure with Docker. Standard Cloud Foundry application containers do not automatically provide this runtime. Custom generation returns an explicit unavailable/error state until the runtime and SAP AI Core are configured. The application never executes generated code in its own process.

## API additions

All application APIs except health/auth require a verified identity. Dataset owner/admin/grants are enforced server-side. Numerical routes require `X-Dataset-Id`, `X-Dataset-Version`, `X-Semantic-Revision`; omitted version/revision resolves once per request. Prefer all three headers for reproducibility. SSE retains the same pinned context for its lifetime. Chat session ownership and context are verified before adding or reading messages.

| Endpoint | Purpose |
|---|---|
| `POST /api/upload/discover`, `/api/upload/preview` | Source structure and transformation preview; multipart `file`, optional `plan` JSON. |
| `POST /api/upload` | Commit reviewed file using the same `plan`. |
| `GET /api/datasets/{id}/data?version=N` | Read an immutable historical version. |
| `GET /api/datasets/{id}/compare?from_version=N&to_version=M&keys=ID` | Row/schema differences with unique stable keys. |
| `GET/PUT /api/datasets/{id}/access` | Owner/admin dataset grants. |
| `/api/datasets/{id}/versions/{N}/semantics` | List revisions or POST an edited model. |
| `POST .../semantics/propose`, `POST .../semantics/{revision}/review` | Propose and explicitly approve/reject. |
| `POST /api/datasets/{id}/versions/{N}/reuse` | Explicit compatible reuse from `source_version` and `semantic_revision`. |
| `GET .../workflow`, `GET .../profile` | Persisted stage state and ingestion profile. |
| `POST /api/insights/execute` | Execute a validated plan. |
| `GET/POST /api/insights/recommendations` | Read or propose independent definition revisions. |
| `POST /api/insights/definitions`, `POST .../{id}/{revision}/review` | Edit or review one definition. |
| `POST /api/insights/dashboard`, `GET /api/dashboard` | Publish approved references and execute the publication. |
| `/api/system/connections`, `/connector-types`, `/bindings` | Connection and source binding administration. |
| `POST /api/system/bindings/{id}/sync` | Queue a sync with an explicit idempotency key. |
| `/api/system/jobs`, `/{id}/events`, `/{id}/cancel`, `/{id}/retry` | Recoverable job state and SSE. |
| `/api/system/ai`, `/storage`, `/access`, `/audit` | Server-side configuration and auditing. |

FastAPI `/docs` supplies exact request models. Dataset mutation APIs continue to create versions; rollback moves the current catalog pointer without rewriting historical snapshots. For independent replacement uploads, use source keys when comparing versions because local row IDs are newly assigned. Concurrent row mutations are serialized. Row edit, append and delete requests carrying matching dataset/version headers reject stale versions with HTTP 409; clients should refresh after a conflict.

## Explicit migration

Back up the legacy output directory, HANA metadata/history and credential key first. The migration never runs at application startup. The default invocation is read-only:

```powershell
python scripts/migrate_metadata_platform.py --owner-id USER_ID --workspace default
```

Review the report and owner mapping. Then run the corresponding explicit operation in a maintenance window:

```powershell
python scripts/migrate_metadata_platform.py --owner-id USER_ID --workspace default --apply
# Or copy local catalog/source versions to configured durable persistence:
python scripts/migrate_metadata_platform.py --owner-id USER_ID --workspace default --apply --to-durable
```

Migration preserves dataset/version IDs, source bytes and legacy vectors/history, makes a local catalog backup, rejects mismatched owners and refuses a nonempty durable destination. It proposes legacy sales semantics from the existing mapping; `orders` maps to OrderID rather than Quantity. `--approve-sales-model --grain "One order line"` is an explicit operator assertion; omit it unless that grain and mapping have been reviewed. Non-sales data remains proposed. Existing rounding cannot be reversed without original files. Legacy chat sessions without context remain readable as history but cannot accept new scoped messages until separately mapped; automatic guessing of their dataset is intentionally avoided.

Top-level legacy CSV/Excel files that have no catalog entry are listed and parsed during dry-run; `--apply` registers them without rewriting the source bytes. Edited Excel versions are actual workbook artifacts. Decimal values and integers beyond Excel's safe numeric precision are written as text cells, preserving exact values; timezone-aware dates use ISO text because Excel has no native timezone representation.

Reindex migrated versions explicitly to adopt workspace/model fingerprints. Review new uploads or use the compatible-definition reuse action. To reverse a local metadata migration, stop writers and restore the reported catalog backup and matching metadata backup; do not delete source objects or overwrite a live destination catalog. No live migration has been executed as part of this change.

## Verification and remaining operational work

Backend unit/integration tests cover sales/HR/manufacturing ingestion and semantic proposals; precision/null/identifier preservation; approval-to-publication HTTP flow; context/ACL isolation; safe formulas/cardinality; source checkpoint recovery/idempotency; object-write failure; and migration safeguards. Frontend tests cover dataset behavior, navigation, account-scoped selection, failed charts and actual dashboard widgets. Run from the repository root:

```powershell
backend/api/venv/Scripts/python.exe -m unittest discover -s backend/tests -v
# From frontend:
npm run lint
npm run test
npm run build
```

These tests use isolated temporary storage and mocked external providers. Live HANA transactions, cloud buckets, SAP APIs, SOAP schemas, NIM models and Docker charts still need tenant-specific acceptance tests. Broad load testing, HANA failover testing, scheduled synchronization, automatic object garbage collection and a polished visual relationship/formula designer remain outside the verified behavior. The advanced semantic editors expose validated JSON contracts; they are not a drag-and-drop designer. Upload/extraction currently materializes one dataset in memory; large-volume deployments require measured sizing and streaming before claiming scale.

Latest verification on 2026-10-18: 92 backend tests passed in 4.137 seconds, 11 frontend tests passed, TypeScript checking passed, and the production build passed (3.42 seconds with warm local caches). These are development verification times, not application latency or scalability measurements. The build reports a roughly 594 kB JavaScript bundle/chunk-size warning and a future Vite configuration-loader warning; neither is a build failure.
