"""Dataset deletion removes personal placements without destroying dashboards."""

from contextlib import nullcontext
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

from api.models.execution_context import current_identity
from api.platform.content_cleanup import remove_dataset_widgets
from api.platform.store import MetadataStore
from api.services.dataset_service import DatasetService


class DatasetDashboardCleanupTests(TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = MetadataStore(
            Path(self.temp.name) / "metadata.sqlite3", backend="sqlite"
        )
        self.namespace = "files-v1:owner"
        self.source = {"dataset_id": "deleted", "version": 1, "semantic_revision": 1}

    def dashboard(self, namespace=None, **values):
        ns = namespace or self.namespace
        doc = dict(
            id="dashboard",
            kind="dashboard",
            workspace_id="workspace",
            tenant_id="tenant",
            user_id="owner",
            name="Report",
            revision=1,
            deleted=False,
            archived=False,
            pages=[
                {
                    "id": "one",
                    "widgets": [
                        {"id": "old", "source": self.source, "width": 2},
                        {"id": "keep", "source": {"dataset_id": "other"}, "width": 3},
                    ],
                },
                {
                    "id": "two",
                    "widgets": [
                        {"id": "old-version", "source": {**self.source, "version": 2}}
                    ],
                },
            ],
            filter_groups=[
                {"source": self.source, "filters": []},
                {"source": {"dataset_id": "other"}, "filters": []},
            ],
        )
        doc.update(values)
        self.store.put(ns, "index", {doc["id"]: {"kind": "dashboard", "revision": 1}})
        self.store.put(ns, doc["id"], doc)
        self.store.put(
            ns + ":history:dashboard", "1", {"action": "create", "document": doc}
        )
        return deepcopy(doc)

    def cleanup(self):
        return remove_dataset_widgets(
            self.store, "workspace", "deleted", tenant_id="tenant", actor_id="admin"
        )

    def test_removes_all_versions_and_updates_index_and_history(self):
        before = self.dashboard()
        result = self.cleanup()
        self.assertEqual(result, {"widgets_removed": 2, "dashboards_updated": 1})
        doc = self.store.get(self.namespace, "dashboard")["value"]
        self.assertEqual(doc["pages"][0]["widgets"], [before["pages"][0]["widgets"][1]])
        self.assertEqual(doc["pages"][1]["widgets"], [])
        self.assertEqual(len(doc["filter_groups"]), 1)
        self.assertEqual(doc["revision"], 2)
        self.assertEqual(doc["modified_by"], "admin")
        self.assertEqual(
            self.store.get(self.namespace, "index")["value"]["dashboard"]["revision"], 2
        )
        self.assertEqual(
            self.store.get(self.namespace + ":history:dashboard", "1")["value"][
                "document"
            ],
            before,
        )
        self.assertEqual(
            self.store.get(self.namespace + ":history:dashboard", "2")["value"][
                "action"
            ],
            "dataset deleted",
        )
        self.assertEqual(
            self.cleanup(), {"widgets_removed": 0, "dashboards_updated": 0}
        )

    def test_covers_other_owners_archived_and_deleted_dashboards_but_isolates_scope(
        self,
    ):
        self.dashboard()
        self.dashboard("files-v1:second", archived=True)
        self.dashboard("files-v1:third", deleted=True)
        other_workspace = self.dashboard(
            "files-v1:other-workspace", workspace_id="elsewhere"
        )
        other_tenant = self.dashboard("files-v1:other-tenant", tenant_id="elsewhere")
        self.assertEqual(
            self.cleanup(), {"widgets_removed": 6, "dashboards_updated": 3}
        )
        self.assertEqual(
            self.store.get("files-v1:other-workspace", "dashboard")["value"],
            other_workspace,
        )
        self.assertEqual(
            self.store.get("files-v1:other-tenant", "dashboard")["value"], other_tenant
        )

    def test_retains_empty_dashboard_and_pages(self):
        self.dashboard(
            pages=[{"id": "one", "widgets": [{"id": "old", "source": self.source}]}]
        )
        self.cleanup()
        doc = self.store.get(self.namespace, "dashboard")["value"]
        self.assertEqual(doc["name"], "Report")
        self.assertEqual(doc["pages"], [{"id": "one", "widgets": []}])
        self.assertIn("dashboard", self.store.get(self.namespace, "index")["value"])

    def test_history_cannot_restore_deleted_sources(self):
        from api.models.content import Revision
        from api.platform.content_dashboard import restore_revision

        workspace = MagicMock()
        workspace.resolve.return_value = workspace
        workspace.store.transaction.side_effect = nullcontext
        workspace.get.return_value = {"kind": "dashboard", "revision": 3}
        workspace.store.get.return_value = {
            "value": {
                "document": {
                    "pages": [{"widgets": [{"source": self.source, "digest": "pin"}]}],
                }
            }
        }
        with (
            patch(
                "api.platform.content_dashboard.ContentWorkspace",
                return_value=workspace,
            ),
            patch(
                "api.platform.content_dashboard.calculate",
                side_effect=HTTPException(404, "Dataset not found."),
            ),
        ):
            with self.assertRaises(HTTPException):
                restore_revision("dashboard", 1, Revision(revision=3))
        workspace.save.assert_not_called()

    def test_cleanup_rolls_back_document_and_history_on_index_conflict(self):
        before = self.dashboard()
        put = self.store.put

        def conflict(ns, key, *args):
            if key == "index":
                raise HTTPException(409, "Concurrent edit")
            return put(ns, key, *args)

        with patch.object(self.store, "put", side_effect=conflict):
            with self.assertRaises(HTTPException):
                self.cleanup()
        self.assertEqual(self.store.get(self.namespace, "dashboard")["value"], before)
        self.assertIsNone(self.store.get(self.namespace + ":history:dashboard", "2"))

    def test_dataset_deletion_stops_before_destructive_steps_when_cleanup_fails(self):
        service = DatasetService(
            output_dir=Path(self.temp.name),
            repository=SimpleNamespace(store=self.store),
        )
        entry = {
            "id": "deleted",
            "name": "Dataset",
            "workspaceId": "workspace",
            "versions": [],
        }
        with (
            patch.object(
                service, "_catalog", return_value={"datasets": {"deleted": entry}}
            ),
            patch(
                "api.platform.content_cleanup.remove_dataset_widgets",
                side_effect=HTTPException(503, "Cleanup unavailable"),
            ),
            patch(
                "api.database.hana_table_service.hana_table_service.drop_table"
            ) as drop,
            patch("api.database.vector_client.vector_client.delete_dataset") as vectors,
        ):
            with self.assertRaises(HTTPException):
                service.delete("deleted")
            drop.assert_not_called()
            vectors.assert_not_called()

    def test_dataset_delete_invokes_cleanup_and_reports_counts(self):
        self.dashboard()
        service = DatasetService(
            output_dir=Path(self.temp.name),
            repository=SimpleNamespace(store=self.store),
        )
        entry = {
            "id": "deleted",
            "name": "Dataset",
            "workspaceId": "workspace",
            "versions": [],
        }
        catalog = {"datasets": {"deleted": entry}, "activeDatasetId": "deleted"}
        token = current_identity.set(
            {
                "user_id": "admin",
                "workspace_id": "workspace",
                "tenant_id": "tenant",
                "role": "admin",
            }
        )
        try:
            with (
                patch.object(service, "_catalog", return_value=catalog),
                patch.object(service, "_writer", side_effect=nullcontext),
                patch.object(service, "_write_json"),
                patch.object(service, "_invalidate"),
                patch(
                    "api.database.hana_table_service.hana_table_service.table_exists",
                    return_value=False,
                ),
                patch(
                    "api.database.vector_client.vector_client.delete_dataset",
                    return_value=True,
                ),
                patch(
                    "api.platform.datasets_metadata_repository.datasets_metadata_repo.delete_dataset",
                    return_value=True,
                ),
            ):
                result = service.delete("deleted")
        finally:
            current_identity.reset(token)
        self.assertEqual(result["deleted"]["dashboard_widgets_removed"], 2)
        self.assertEqual(result["deleted"]["dashboards_updated"], 1)
        self.assertEqual(
            len(
                self.store.get(self.namespace, "dashboard")["value"]["pages"][0][
                    "widgets"
                ]
            ),
            1,
        )
