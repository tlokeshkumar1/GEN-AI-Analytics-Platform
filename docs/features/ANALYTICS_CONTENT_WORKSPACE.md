# My Files

My Files sits between AI Dashboards and Administration in the platform sidebar. A compact sidebar opens a dedicated file browser. Open **Add Files** to create a root dashboard or folder. A folder can include its first dashboard in the same creation transaction. The three-dot menu supports renaming, moving and soft deletion. Deleting a folder hides its subtree. Restore the folder from the recycle bin to recover its contents.

In Widgets or Graph Studio, review a versioned definition. System-approved recommendations have a **Confirm for My Files** action. Select **Publish approved objects to My Files**, choose objects, destination dashboards and pages, and confirm. The dialog can create missing destinations. Each destination reports its own outcome. A dashboard opens at `/dashboards/<id>` and renders its pages through the existing chart and KPI components.

Owners can duplicate dashboards, manage grants and restore earlier layouts. Editors can add, reorder, rename, duplicate and remove pages, change placement width and title, and reorder placements with drag-and-drop or buttons. Changes take effect after the API saves them.

## Implementation checkpoint

Branch `feature/analytics-content-workspace`. The personal hierarchy, HANA document repository, owner/view/edit dashboard permissions, sharing UI, approved-object destination workflow, pinned single-source execution per placement, multi-page layouts and revision restoration are implemented. Deployment requires the private binding and migration in [the migration guide](CONTENT_WORKSPACE_MIGRATION.md). The next verification gate is an authorized HANA Cloud test schema with separate private-content and SQL-console principals.

## Remaining scope

- The Add Files menu includes Shared with me, Favourites, Recently viewed, Archive and Recycle bin. Foundation and governance still need folder sharing and duplication, delegated share/manage-access permissions, retention, administrative recovery, and workspace policy settings. The sharing directory contains verified users who have opened My Files.
- AI Agents, RAG Chat, Widgets and Graph Studio share a publication dialog for saved, reviewed definitions. Publishing still needs a hierarchical destination browser and per-object draft editing. A transient graph preview or chat suggestion must first become a versioned definition.
- Studio persists filters at dashboard, page and widget level. A dashboard or page filter applies only to widgets with the exact same dataset, version and semantic revision. Free-form coordinates, height resizing, advanced formatting, explicit draft publishing and undo/redo remain open. Current layouts persist order and width on a responsive grid. Dashboard search uses the bounded personal index in memory. Paginated server search and lazy subtree loading are pending.
- Data lifecycle still needs latest-compatible refresh, calculated-result snapshots, validated historical joins, cross-dataset filter mappings and version-aware drill-through. The current implementation supports independently pinned single-source placements and rejects joins and mutable table-only sources.
- Dashboard-aware chat, AI dashboard drafts and layout suggestions, scheduled refresh and delivery, templates, exports, linked interactions and dashboard comparison are deferred. Dashboard metadata and results are supplied only by the content and execution APIs.
- End-to-end browser, two-domain ingestion-to-publication, live HANA concurrency and Cloud Foundry session-restoration verification remain open. The existing Executive Dashboard and its legacy publication flow continue to use their original routes.

