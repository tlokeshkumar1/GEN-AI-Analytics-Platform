# My Files in the application HANA schema

My Files uses the same configured HANA connection pool and schema as application metadata. A separate content service or HDI container is not required. `personal_store()` always selects the HANA backend, with the existing `HANA_*` settings or application HDI binding.

## Storage

All content operations address `PLATFORM_DOCUMENTS`. In the current installation this is a synonym for `PLATFORM_METADATA` in the configured application schema. Existing dataset and definition documents remain in that table. Personal files, preferences, grants and history use their existing `files-v1:` and `files-users:` namespaces. Application ownership and sharing checks remain enabled.

The application SQL browser can access these records through its existing database account. This shared-schema arrangement was explicitly requested; it does not provide database isolation from SQL-browser administrators.

For a new installation, deploy the existing application database artifacts or apply the appropriate application metadata migration. The API does not create or alter tables at startup. Do not replace an existing `PLATFORM_DOCUMENTS` synonym with another table.

## Consolidation completed on 25 November 2026

The one document in the temporary `analytics-content-hana` container was copied to the application schema with its namespace, document ID, revision and payload preserved. The copy was read back and compared before deleting the separate service. A local backup is retained under the git-ignored `backend/preprocessing/output/content-schema-migration-backup-*.json` path.

The separate content binding and deployment requirement were removed. Local source now uses the application pool; applying this source change to a deployed API requires its normal deployment. Existing dataset and dashboard ownership was not reassigned.

## Verification

Run `python scripts/preview_content_workspace.py` with the backend environment for a read-only document-store preflight. The consolidation also verified insert, read, update and delete through `personal_store()` against live HANA, rolling back the verification transaction. No probe records were retained.

After refreshing the local frontend, create a folder and save a dashboard through My Files. In the SQL browser, inspect `PLATFORM_METADATA` for the saved document namespaces. Saving layouts does not duplicate the source datasets.
