# SAP authentication and chat history recovery

The backend validates real SAP XSUAA end-user tokens in local development and SAP BAS. User management and chat history have no authentication bypass or simulated records.

## Verified configuration

The configured XSUAA signing key was malformed. It has been refreshed from the configured issuer and verified against a real application service token. The backend clock was within about three seconds of SAP's server time; timestamp validation remains enabled.

The final role collection names confirmed in the BTP cockpit are:

- `GEN-AI Analytics Platform Administrator (dev)`
- `GEN-AI Analytics Platform Member (dev)`
- `GEN-AI Analytics Platform User Management (dev)`

Local configuration uses these exact names. The standalone `xs-security.json` contains the dev collection names; MTA configuration overrides them for its target space. Do not use literal `${space}` collection names when updating XSUAA directly with a JSON descriptor. User Management requires both the project Administrator scope and the read-only directory scopes from the User Management collection. Sign out and in after assignment changes.

HANA already has the chat tables in this schema:

```text
2160285FC6414F45AEDC46A0122AB3CE_31D39YTV1CUTGZLY25NTGX9U4_RT
```

Both tables have all required columns. The live read-only check found three sessions and six messages, with no NULL/default-user session owners. The previous `HANA_SCHEMA` pointed to the HDI schema without the runtime-user suffix. Local configuration now selects the existing tables' schema explicitly. No tables were created or replaced and no records were inserted, deleted or reassigned.

## Restart local processes

Restart the existing backend, frontend and local AppRouter so they read the corrected configuration. Using the installed Python environment from the project root:

```powershell
backend/api/venv/Scripts/python.exe -m uvicorn api.app:app --app-dir backend --reload --port 8000
```

In a separate terminal:

```powershell
npm run start:frontend
```

Vite proxies `/api` to port 8000. For AppRouter-based SSO, the local router now loads the root `default-env.json`, including the destination with `forwardAuthToken`. The default router port is 5000; use your configured port when exposing it in BAS. A Vite preview and an AppRouter session are different entry points.

## Apply in SAP BAS or Cloud Foundry

Apply the updated source and the exact role/schema settings to the BAS workspace. Keep service keys and passwords in private configuration. The backend ignores packaged local `.env` files on Cloud Foundry.

The MTA no longer embeds HANA or NVIDIA credentials. `deployment.private.mtaext` in this workspace contains the existing private credentials and corrected HANA schema; it is excluded from Git. This preserves access to the existing runtime-user tables rather than switching database identities and losing their visibility. Use that private extension, or equivalent protected settings, when deploying:

```bash
cf login --sso
cf target
mbt build -t ./mta_archives
cf deploy mta_archives/gen-ai-analytics-platform_1.0.0.mtar -e deployment.private.mtaext
```

Enter login credentials/passcodes only in the terminal. Verify the intended organization and dev space before deployment. Use the actual archive filename produced by `mbt`. The private extension must be supplied securely if deploying from another workspace. Do not commit it.

## Diagnose without exposing credentials

From a terminal with backend Python dependencies:

```bash
python scripts/check_sap_environment.py --hana
python scripts/check_sap_environment.py --catalog
python scripts/check_sap_environment.py --cf
```

`--hana` checks the configured schema and columns. `--catalog` searches accessible schemas and reports table metadata and aggregate record counts, without conversation content. `--cf` checks deployed API/router bindings and requires an authenticated CLI. `--refresh-bindings` refreshes local XSUAA from the deployed binding; `--refresh-signing-key` verifies and refreshes the issuer's active signing key. Do not initialize new tables to resolve a schema mismatch.

In browser DevTools, verify `/api/auth/me`, `/api/users` and `/api/chat/sessions` through the same frontend origin. Successful responses must be JSON. An HTML login page, expired session, missing permission or unavailable backend now produces an actionable error. SCIM Groups is not treated as the complete cockpit role collection catalog, so an unassigned collection does not block other valid accounts. The UI lists users with direct project role assignments and shows the exact collection names it uses.

Verify that your real account can reopen its saved conversations after a restart, and that another account cannot read or delete those conversations. Session ownership comes only from verified SAP identity; client-supplied IDs and legacy unowned sessions cannot grant access.

## Checks

```bash
python -m unittest discover -s backend/tests
npm run lint --prefix frontend
npm run build --prefix frontend
```

Regression fixtures are isolated from application data. Live browser login and account membership require the authenticated SAP environment. The implementation follows [SAP's token validation library](https://github.com/SAP/cloud-pysec); signature and timestamp verification are always enabled.
