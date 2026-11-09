# Local Setup and Development

Run commands from the repository root. The frontend uses port **3000** and FastAPI uses port **8000**.

## Prerequisites and environment

Use Python 3.10 or later and Node.js compatible with the checked-in frontend dependencies. After installing dependencies, Vite's `package.json` records its supported Node versions.

Copy the template once, preserving existing configuration:

```powershell
Copy-Item .env.example .env
```

On macOS/Linux use `cp .env.example .env`. The backend automatically loads the root environment file. Add feature-specific settings missing from the template:

| Settings | Purpose |
| --- | --- |
| `HANA_ADDRESS`, `HANA_PORT`, `HANA_USER`, `HANA_PASSWORD`, `HANA_SCHEMA` | HANA database; port defaults to 443 |
| `NVIDIA_API_KEY` | NVIDIA chat and embeddings |
| `NVIDIA_LLM_MODEL`, `NVIDIA_LLM_URL` | Optional chat model/endpoint overrides |
| `NVIDIA_EMBEDDING_MODEL`, `NVIDIA_API_URL` | Optional embedding model/endpoint overrides |
| `AICORE_AUTH_URL`, `AICORE_CLIENT_ID`, `AICORE_CLIENT_SECRET`, `AICORE_RESOURCE_GROUP`, `AICORE_BASE_URL` | SAP AI Core graph code generation |
| `AICORE_DEPLOYMENT_ID`, `AICORE_DEPLOYMENT_URL` | Graph generation deployment configuration |
| `XSUAA_URL`, `XSUAA_AUTH_URL`, `XSUAA_CLIENT_ID`, `XSUAA_CLIENT_SECRET`, `XSUAA_XSAPPNAME` | Local SAP authentication configuration |
| `XSUAA_SERVICE_NAME`, `XSUAA_ADMIN_ROLE_COLLECTION`, `XSUAA_MEMBER_ROLE_COLLECTION` | Exact binding and project collection names |
| `XSUAA_APPLICATION_CREDENTIALS` | Optional service-key JSON for directory access/validation |
| `DATA_REFRESH_INTERVAL_MINUTES`, `DATA_STALE_MAX_HOURS` | Dataset freshness; defaults 15 and 24 |
| `APP_ENV`, `LOG_LEVEL`, `PORT` | Runtime settings |

Use private environment files/bindings for credentials. The frontend uses relative API requests; Gemini/App URL fields in its template do not configure the Python API connection.

## Backend

PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend/requirements.txt
python -m uvicorn api.app:app --app-dir backend --reload --port 8000
```

On macOS/Linux replace activation with `source .venv/bin/activate`. If PowerShell activation is unavailable, invoke `.\.venv\Scripts\python.exe` directly for install/server commands.

The root `npm run start:backend` is an alternative once Uvicorn is available in the active environment. Cloud Foundry uses `backend/Procfile` and `backend/requirements.txt`.

Check [health](http://localhost:8000/api/health), [Swagger](http://localhost:8000/docs), and [ReDoc](http://localhost:8000/redoc). The health AI Core flag only checks a client ID. HANA failures can skip chat-table initialization while the server stays available.

## Frontend

In a second terminal:

```powershell
npm ci --prefix frontend
npm run start:frontend
```

Open [http://localhost:3000](http://localhost:3000). Vite proxies API requests to port 8000; keep both processes running.

Local Vite does not provide the deployed SAP session. Backend profile requests require a Bearer token. Use a configured local SAP login/token flow; for complete hosted SAP sign-in, use the deployed router described in [deployment](deployment.md). User Management also requires an application binding, the project Administrator role and both directory read scopes. See [SAP authentication and chat history recovery](sap-auth-history-recovery.md) for the verified dev role names and existing chat schema.

## Dataset

The standard file is `backend/preprocessing/output/SAC_Sales_Preprocessed.xlsx`. The loader can also use `backend/preprocessing/input/SAC_Sales_Flat_SingleSheet.xlsx` when available. Dataset Ingestion uploads replace the standard file and update the handling process's cache.

Calculations expect columns such as `NetRevenueUSD`, `GrossMarginUSD`, `Quantity`, `Region`, `Country`, `Category`, and time dimensions. Upload validates parsing, rather than enforcing every expected sales column. XLSX and CSV use installed dependencies; XLS is accepted by filename validation but may require an additional reader engine.

An empty dataset produces zero/empty dashboard values; analytics can return example fallback results. Upload saves files without generating vectors. HANA history and vector retrieval require a working database connection.

## Build and checks

```powershell
npm run build:frontend
npm run lint --prefix frontend
python -m unittest discover -s backend/tests
```

Build writes `frontend/dist/`; lint runs TypeScript checking. Backend unit tests cover XSUAA user management. These checks do not establish live SAP/NVIDIA connectivity.

`npm start` runs the router, which additionally needs service bindings, destination configuration, and built assets in `router/resources/`. The MTA build assembles these assets.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Vite API requests fail | Backend listening on port 8000 |
| Chat/embeddings fail | NVIDIA key, endpoints, and models |
| Graph code generation fails | AI Core credentials/deployment and fallback logs |
| Missing sales data | Dataset path, columns, upload status |
| History unavailable | HANA connectivity/schema/table privileges |
| Profile returns 401 | Bearer token locally or active router session |
| Directory returns 403/503 | Role collections, fresh token, matching binding with `apiurl` |

See [API contracts](api.md) and [architecture](architecture.md) for current behavior and limitations.
