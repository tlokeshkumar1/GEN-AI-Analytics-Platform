# Content API

All paths are relative to `/api/content`. Requests use the platform's authenticated API client and App Router CSRF handling. Stable file, page and placement IDs are lowercase 32-character hexadecimal strings.

| Method and path | Behavior |
| --- | --- |
| GET /tree | Visible private and shared file summaries. Use `deleted=true` for the owner's recycle bin or `archived=true` for archived entries. Favourite and last-opened fields belong to the caller. |
| PUT /files/{id}/favourite | Set the caller's favourite flag on an accessible file. |
| POST /files/{id}/opened | Record recent activity after resolving the caller's current access. |
| POST /files | Create with kind, name, description and nullable parent_id. An optional first_dashboard name creates a dashboard with the folder atomically. |
| GET /files/{id} | Current file document and effective permission. |
| PATCH /files/{id} | Supply revision and changed name, description, parent_id, archived or deleted flag. A null parent moves to root. |
| POST /files/{id}/duplicate | Duplicate a dashboard into the specified destination with fresh page and placement IDs. |
| GET /users | Eligible registered sharing recipients in this tenant and workspace. |
| POST /files/{id}/access | Owner supplies revision, recipient and permission (view, edit or revoke). |
| GET /preferences, PUT /preferences | Load or revision-check the signed-in user's folded folders and section state. |
| POST /files/{id}/publish | Publish up to 30 source references transactionally to a page. |
| POST /files/{id}/refresh?page_id={page} | Execute a page. Returns document revision and placement-keyed results or errors. |
| PUT /files/{id}/filters | Save conditions with revision, placement_id and scope (widget, page or dashboard). The selected placement determines the exact source context. Filter values are returned only after authorized execution. |
| POST /files/{id}/pages | Add, rename, duplicate, remove or reorder pages with a revision and action. |
| PATCH /files/{id}/widgets/{placement} | Edit title/width, remove, duplicate, move to target_id, or reorder with up/down. Requires revision. |
| GET /files/{id}/history | Owner-visible revision documents and action labels. |
| POST /files/{id}/history/{previous}/restore | Restore dashboard name, description, pages and publication state into a new revision. Supply current revision. |

## Publication contract

A request contains `request_id` (UUID), destination `revision`, `page_id`, `duplicates` (skip, replace or add), and `sources`. Each source specifies `dataset_id`, `version`, `semantic_revision`, definition `id` and definition `revision`. The client never supplies executable SQL or calculated results. The response contains `dashboard_id`, `revision` and `placements_written`. Reusing a request ID with an altered payload returns HTTP 409. Multiple destinations receive separate calls and individual outcomes.

Invalid inputs return 422, unknown or private resources return 404, insufficient edit or source access returns 403, and revision/name conflicts return 409. Missing HANA configuration or an inaccessible repository returns 503. The FastAPI OpenAPI schema describes individual request fields.

