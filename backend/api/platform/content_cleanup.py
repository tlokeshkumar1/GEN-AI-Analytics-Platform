"""Remove deleted dataset placements while retaining personal dashboard layouts."""

from api.platform.content import timestamp


def remove_dataset_widgets(
    store, workspace_id, dataset_id, *, tenant_id=None, actor_id=None
):
    removed = updated = 0
    for namespace in store.personal_file_namespaces():
        with store.transaction():
            index_row = store.get(namespace, "index")
            if not index_row:
                continue
            index = index_row["value"]
            keys = [
                key for key, item in index.items() if item.get("kind") == "dashboard"
            ]
            documents = store.get_many(namespace, keys)
            changed = False
            for key, row in documents.items():
                doc = row["value"]
                if (
                    doc.get("kind") != "dashboard"
                    or doc.get("workspace_id") != workspace_id
                    or (tenant_id is not None and doc.get("tenant_id") != tenant_id)
                ):
                    continue
                count = 0
                for page in doc.get("pages", []):
                    widgets = page.get("widgets", [])
                    retained = [
                        w
                        for w in widgets
                        if w.get("source", {}).get("dataset_id") != dataset_id
                    ]
                    count += len(widgets) - len(retained)
                    page["widgets"] = retained
                if not count:
                    continue
                # Filters for a removed source must not remain on the dashboard/page.
                for container in [doc, *doc.get("pages", [])]:
                    if "filter_groups" in container:
                        container["filter_groups"] = [
                            group
                            for group in container["filter_groups"]
                            if group.get("source", {}).get("dataset_id") != dataset_id
                        ]
                revision = row["revision"]
                doc.update(
                    revision=revision + 1,
                    updated_at=timestamp(),
                    modified_by=actor_id or "system",
                )
                store.put(namespace, key, doc, revision)
                index[key]["revision"] = doc["revision"]
                store.put(
                    namespace + ":history:" + key,
                    str(doc["revision"]),
                    {
                        "action": "dataset deleted",
                        "dataset_id": dataset_id,
                        "document": doc,
                    },
                )
                changed = True
                removed += count
                updated += 1
            if changed:
                store.put(namespace, "index", index, index_row["revision"])
    return {"widgets_removed": removed, "dashboards_updated": updated}
