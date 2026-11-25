# Content authorization

Admin and Member use the existing XSUAA scopes. Both own their personal file trees. Resource ownership is established from verified identity claims and the deployment workspace. My Files rejects local development tokens before opening a database connection. Client input cannot assign a file owner or tenant.

| Operation | Owner | Dashboard editor | Dashboard viewer |
| --- | --- | --- | --- |
| Open dashboard and request results | Yes | Yes | Yes |
| Change pages, layout and publish placements | Yes | Yes | No |
| Rename, move, duplicate, delete or restore the dashboard | Yes | No | No |
| Grant or revoke access, read history, restore a revision | Yes | No | No |

The owner selects another registered user from the same tenant and workspace. Grants are explicit and dashboard-specific. A recipient sees shared dashboards at the root of their file listing. Each access resolves the current grant and the visibility of the owner's folder hierarchy. Owner-only restoration preserves current grants. Ancestor deletion temporarily hides shared descendants. Restoring the ancestor makes existing grants effective again.

The dataset service independently enforces workspace and dataset grants for every placement. Existing dataset Admin policy applies to source datasets. A dashboard grant alone cannot authorize source execution. Content APIs return private, no-store responses. Ordinary refresh uses the deterministic engine and performs no LLM requests. Cross-table execution and dashboard-aware RAG are deferred until their source authorization and version guarantees can be verified.

My Files documents share the application's HANA connection pool and schema. API ownership, tenant, workspace and explicit sharing checks continue to apply. The application's SQL-browser account can also read these documents directly; database isolation from that account is not enforced. Content history records actor, timestamp and action in the application document store. Administrative recovery, retention and delegated grant management are pending.
