# Content workspace architecture

The React sidebar and Graph Studio call the existing Axios client and FastAPI application. XSUAA middleware binds the user, tenant and deployment-owned workspace to each request. A personal dashboard route loads its own document and page. Dashboard execution is independent of the global dataset picker.

| Layer | Implementation |
| --- | --- |
| Routing and contracts | `api/routes/content.py` and `api/models/content.py` |
| Ownership, hierarchy, index, grants and revisions | `api/platform/content.py` |
| Pages, placements and revision restoration | `api/platform/content_dashboard.py` |
| Strict HANA repository and connection isolation | `api/platform/content_store.py`, existing `MetadataStore` and `HANAConnectionManager` |
| Definition resolution and execution | `api/platform/content_publication.py`, existing semantic registry namespaces, dataset repository, QueryPlan, AnalyticsEngine and AnalyticsWidget |
| React integration | ContentFiles, DashboardAccess, PublishToFiles, PersonalDashboard, Sidebar, GraphStudio and App |

## Persistence

A private HANA Cloud schema contains a versioned document table keyed by namespace and document ID. The existing platform schema retains datasets, semantic models and reusable analytical definitions. Tenant, workspace and user participate in the private namespace digest. The owner index contains hierarchy metadata. Each file has its own document and revision. Pages and placements have immutable IDs. Historical documents, recipient share indexes, workspace user registration, expansion preferences and publication receipts occupy separate keys.

An outer HANA transaction contains document writes, the index compare-and-swap, revision history and any publication receipt. The repository disables autocommit while it owns the connection and restores the original state before returning it to its pool. A concurrent revision failure rolls the transaction back. Each destination is a separate transaction. The browser retries a submission with the same request UUID. Large hierarchies currently share one owner index. Defaults are 1,000 files per owner, 16 hierarchy levels, 30 pages per dashboard and 100 placements per dashboard.

Names use NFC normalization, trimmed whitespace, a 120-character limit and Unicode case folding for sibling uniqueness across folders and dashboards. Path separators and ASCII control characters below 32 are excluded. Soft-deleted names can be reused. Restoration validates collisions and parent visibility again.

## Execution

Publication reads the exact dataset version, approved semantic revision and reviewed analytical definition. It checks for a newer source revision, rejects unreviewed and cross-source plans, and evaluates the pinned snapshot with the deterministic engine before saving a reference. The placement records a digest of the semantic document, definition and snapshot reference. Refresh verifies the digest and current source grants before returning results. A failed placement returns an error alongside the other page outcomes. Result values are transient. All durable My Files data, including sidebar preferences, belongs in HANA Cloud.

