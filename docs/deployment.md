# Deployment Guide - SAP BTP Cloud Foundry

## MTA Packaging & Cloud Foundry Deployment

### Prerequisites

1. Cloud Foundry CLI with the MultiApps plugin providing `cf deploy`, authenticated to the intended organization and space.
2. Cloud MTA Build Tool (`mbt`), its required build tools, and Node.js/npm compatible with the frontend dependencies.
3. Entitlements for XSUAA (`application`), Destination (`lite`), and a HANA HDI container, with a running SAP HANA Cloud instance.

Confirm the target before deployment:

```bash
cf target
cf plugins
```

### Build Step
Run MTA build from root directory:
```bash
mbt build -t ./mta_archives
```

### Deploy to BTP CF Space
```bash
cf deploy mta_archives/gen-ai-analytics-platform_1.0.0.mtar -e deployment.private.mtaext
```

Use the actual archive filename emitted by `mbt` if it differs. The MTA ID is lowercase `gen-ai-analytics-platform` and the current version is `1.0.0`.

### Modules and services in the current manifest

| Module | Type / source | Runtime |
| --- | --- | --- |
| `gen-ai-analytics-platform-router` | `approuter.nodejs`, `router/` | 256 MB memory, 512 MB disk |
| `gen-ai-analytics-platform-api` | `python`, `backend/` | 512 MB memory, 1024 MB disk |
| `gen-ai-analytics-platform-ui` | `html5`, `frontend/` | Build-only module producing `dist/` |

The frontend build is copied into the router's `resources/` directory. The API starts with `backend/Procfile` and installs `backend/requirements.txt`.

| Service instance | Service / plan | Consumers |
| --- | --- | --- |
| `<space>-gen-ai-analytics-platform-xsuaa` | XSUAA / application | Router and API |
| `<space>-gen-ai-analytics-platform-destination` | Destination / lite | Router and API |
| `<space>-gen-ai-analytics-platform-hdi-container` | HANA HDI container | API |

The `backend-api` destination targets the deployed API and forwards the user's authentication token. Router application names are suffixed with the space, as are API application names.

The manifest does not provision an HTML5 application repository, database deployer, AI Core service binding, or autoscaler. Its scaling configuration alone does not establish working autoscaling. HANA schema artifacts must be deployed separately when required; runtime chat tables are initialized by the API when database privileges allow it.

### Runtime configuration and data

Review `mta.yaml` runtime properties before building. HANA and NVIDIA credentials are supplied by the git-ignored `deployment.private.mtaext` or equivalent protected runtime configuration; they are no longer embedded in the manifest. The private extension preserves access to the existing runtime-user chat schema. HANA environment variables take precedence over HDI binding values in the current backend configuration. AI Core settings use a binding when available, or environment configuration; the current MTA does not add that binding.

Configure NVIDIA access for chat/embeddings and AI Core credentials plus deployment settings for graph code generation. See [setup](setup.md) for setting names.

The API package excludes preprocessing input/output directories. Upload the sales dataset after deployment. Uploads update instance-local files and caches, without inserting sales data or generating vectors in HANA. Cloud Foundry instance storage is not durable or shared across restarts, restaging, or multiple instances; durable dataset storage requires additional implementation.

Verify application status and review backend logs:

```bash
cf apps
cf services
cf logs gen-ai-analytics-platform-api-<space> --recent
```

Replace `<space>` with the target space. Through the authenticated router, verify `/api/health`, upload a dataset, check the dashboard, and exercise chat and graph generation. The health AI Core flag checks configuration only; it does not test an upstream AI call or NVIDIA availability.

## Direct SAP sign-in from the Cloud Foundry URL

Share the **router application's URL** (`gen-ai-analytics-platform-router-<space>`), rather than the API URL. The router protects the application entry point with XSUAA and redirects visitors to the configured SAP identity provider. After authentication, the frontend retrieves `/api/auth/me` using the router session cookie and opens the dashboard without an additional application login or a token stored in the browser.

In the BTP subaccount's **Security > Trust Configuration**, configure the intended SAP IAS tenant as the default identity provider for business users. Configure its upstream SAP identity provider as needed for SAP Universal ID. The sign-in button uses the protected router entry point; the actual provider and sign-in experience depend on this trust configuration.

Assign each authorized user the platform Member or Administrator role collection. SAP authentication alone does not grant application access.

Verify after redeploying:
1. Open the router URL in a private browser window: SAP's hosted sign-in should appear.
2. Complete SAP sign-in: the dashboard should open directly, with the user's name and roles.
3. Refresh with no `auth_token` in local storage: the router session should still open the dashboard.
4. Sign out: the router session should end and the signed-out page should appear.
5. Select **Sign in with SAP Universal ID / BTP IAS** to start a new SAP sign-in.

## Live User Management with XSUAA

The User Management table reads `/api/users` through the authenticated router. It refreshes every 30 seconds while visible and has a manual refresh button. The API validates the token using SAP's `sap-xssec` library and requires the application's `Admin` scope. Members receive HTTP 403.

User Management uses only the existing XSUAA **application** service, `dev-gen-ai-analytics-platform-xsuaa` in the dev space. The MTA binds this service to the router and backend and sets `XSUAA_SERVICE_NAME` so unrelated application bindings cannot be selected. Both backend requirements files include `sap-xssec`.

The new `GEN-AI Analytics Platform User Management (<space>)` collection includes the `UserManagementReader` role template referencing the read-only foreign scopes `xs_user.read` and `xs_authorization.read`. SAP prohibits introducing platform scopes into an already assigned template or an existing collection. Apply the security configuration to the existing service, assign your account both `GEN-AI Analytics Platform Administrator (<space>)` and `GEN-AI Analytics Platform User Management (<space>)`, and sign out and in again to obtain a fresh token with these permissions. These SAP permissions allow directory reads at subaccount level; the API applies the project membership filter before returning records.

The backend validates the signed-in administrator's token against this application's binding and forwards that token to its `apiurl` SCIM `/Users` and `/Groups` endpoints. It returns only users directly assigned to the exact project Administrator or Member collections configured by `XSUAA_ADMIN_ROLE_COLLECTION` and `XSUAA_MEMBER_ROLE_COLLECTION`. Unrelated users and role collection names are excluded from the response. No technical-client token is requested and no additional XSUAA service is used.

Columns use these source fields:

| Column | XSUAA data |
| --- | --- |
| User / Identity | SCIM name, primary email, and identity provider origin |
| Role Descriptor | Direct project role collection assignments from SCIM groups |
| Security Tier | Exact platform Administrator or Member role collection match |
| Status | SCIM `active` flag (account enabled or disabled) |
| Last Login | SCIM `lastLogonTime`, milliseconds since Unix epoch, displayed in the browser's local time |

This lists BTP shadow users, rather than all accounts in an upstream IAS directory. Identity provider mappings can grant additional access and are not resolved by the direct-assignment tier column. Missing or nonpositive last-login timestamps display **Not available**; account status does not indicate online presence. Job titles are not supplied by XSUAA.

For local development, the backend also reads the ignored root `default-env.json` when `VCAP_SERVICES` is absent. Its `VCAP_SERVICES.xsuaa` array contains the project application binding with `name`, `plan`, and `credentials` (including `apiurl`). Alternatively, supply `XSUAA_APPLICATION_CREDENTIALS` as a service-key JSON environment variable. Set `XSUAA_SERVICE_NAME`, `XSUAA_ADMIN_ROLE_COLLECTION`, and `XSUAA_MEMBER_ROLE_COLLECTION` in the root `.env` to the exact deployed names. Install `backend/requirements.txt` in the Python environment used by Uvicorn and restart the backend after configuring it. Use a valid end-user Bearer token from the same application. Never commit service keys.

The table shows **Loading accounts...** or **Accounts unavailable** until the first successful user read. A zero count is shown only after XSUAA confirms an empty result.

SAP references: [Application security scopes and foreign references](https://github.com/SAP-docs/btp-cloud-platform/blob/main/docs/30-development/application-security-descriptor-configuration-syntax-517895a.md), [last-login and account fields](https://help.sap.com/docs/automation-pilot/automation-pilot/getsubaccountuser-command), and [SAP Python token validation library](https://github.com/SAP/cloud-pysec).

For the verified schema, role collection names and restart steps, see [SAP authentication and chat history recovery](sap-auth-history-recovery.md).
