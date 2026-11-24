# HANA Cloud migration and Cloud Foundry operation

The My Files API persists all personal content in a private schema on the existing SAP HANA Cloud instance. It requires the private schema because the platform includes an authenticated administrative SQL browser. The existing dataset and definition repositories remain in their current application schema.

1. In an authorized test environment, provision a private HANA schema and a distinct runtime principal. Grant the private principal the required SELECT, INSERT, UPDATE and DELETE privileges on its document table. Keep the platform's SQL-console account and its inherited roles outside this schema.
2. With the migration principal, select the private schema, verify CURRENT_SCHEMA, and apply `backend/db/migrations/004_private_content_workspace.sql`. The migration creates the document table only when absent. Verify the four column definitions and composite primary key when the table already exists. The application never issues production DDL.
3. Bind a Cloud Foundry user-provided service named `analytics-content-hana` to the API module. Its credentials contain `user`, `password` and `schema`. An optional `host` must equal the existing HANA Cloud host. The content pool uses the existing HANA host and port and verifies the TLS certificate. Override the binding name with `CONTENT_HANA_SERVICE_NAME` if needed. Use a private MTA extension or approved binding procedure to retain it across restages. Store credentials in the binding.
4. Keep platform metadata and durable dataset objects configured for HANA. Set optional `CONTENT_FILE_LIMIT` and `CONTENT_MAX_DEPTH` to positive integers if the default limits require adjustment. After authorized restaging, verify API and App Router access with two distinct users.
5. Run `python scripts/preview_content_workspace.py` only against the authorized test bindings. This read-only preflight checks private table shape, console isolation and the count of legacy dashboard documents. It prints the number of planned personal-file creations and ownership transfers, both zero for this release.

The existing Executive Dashboard, its approvals and links retain their current ownership and visibility. No legacy data is copied into personal files. Users can explicitly publish approved definitions into their own dashboards. Running the migration again does not create another dashboard, sample folder or migration user.

Rollback consists of restoring the prior application build. Retain the private schema and binding for recovery until an approved retention procedure applies. Rehearse rollback and pooled transaction behavior in a test schema first. Source changes, offline tests and the migration script do not by themselves provision a cloud schema. GitHub Actions remains CI-only.

