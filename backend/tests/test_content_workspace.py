"""Offline contract tests. Transient Python fixtures perform no filesystem or cloud writes."""

from contextlib import contextmanager
from copy import deepcopy
from unittest import TestCase
from unittest.mock import MagicMock, patch
from uuid import uuid4

from fastapi import HTTPException
from api.models.execution_context import current_identity
from api.platform.content import ContentWorkspace
from api.platform.content_publication import calculate, publish
from api.platform.semantic import semantic_registry
from api.platform.store import MetadataStore
from api.routes.content import Publication
from api.services.dataset_service import DatasetService


class DocumentFixture:
    backend = "hana"

    def __init__(self):
        self.rows = {}

    @contextmanager
    def transaction(self):
        before = deepcopy(self.rows)
        try:
            yield
        except Exception:
            self.rows = before
            raise

    def get(self, ns, key):
        return deepcopy(self.rows.get((ns, key)))

    def put(self, ns, key, value, expected_revision=0):
        old = self.get(ns, key) or {"revision": 0}
        if old["revision"] != expected_revision:
            raise HTTPException(409, "Conflict")
        row = {"value": deepcopy(value), "revision": expected_revision + 1}
        self.rows[ns, key] = row
        return row

    def list(self, ns):
        return [dict(id=k, **deepcopy(r)) for (n, k), r in self.rows.items() if n == ns]

    def delete(self, ns, key):
        self.rows.pop((ns, key), None)


class FilesTests(TestCase):
    def test_development_token_cannot_reach_hana_content(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from api.routes.content import router
        from api.utils.context_middleware import DatasetContextMiddleware

        app = FastAPI()
        app.add_middleware(DatasetContextMiddleware)
        app.include_router(router)
        with patch("api.platform.content.personal_store") as store:
            response = TestClient(app).get(
                "/api/content/tree", headers={"Authorization": "Bearer dev-token-admin"}
            )
            self.assertEqual(response.status_code, 401)
            store.assert_not_called()

    def test_http_create_destination_pages_history_and_conflicts(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from api.routes.content import router

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)
        with patch("api.platform.content.personal_store", return_value=self.store):
            result = client.post(
                "/api/content/files",
                json={
                    "kind": "folder",
                    "name": "Operations",
                    "first_dashboard": "Report",
                },
            )
            self.assertEqual(result.status_code, 201, result.text)
            doc = result.json()["first_dashboard"]
            path = "/api/content/files/" + doc["id"]
            self.assertEqual(client.get(path).json()["permission"], "owner")
            response = client.post(
                path + "/pages",
                json={"revision": 1, "action": "add", "name": "Details"},
            )
            self.assertEqual(response.json(), {"revision": 2})
            self.assertEqual(
                client.post(
                    path + "/pages",
                    json={"revision": 1, "action": "add", "name": "Stale"},
                ).status_code,
                409,
            )
            copy = client.post(
                path + "/duplicate", json={"kind": "dashboard", "name": "Copy"}
            ).json()
            self.assertEqual(len(copy["pages"]), 2)
            self.assertNotEqual(copy["pages"][0]["id"], doc["pages"][0]["id"])
            restored = client.post(
                path + "/history/1/restore", json={"revision": 2}
            ).json()
            self.assertEqual(restored["revision"], 3)
            self.assertEqual(len(restored["pages"]), 1)
            self.assertEqual(len(client.get(path + "/history").json()), 3)
            self.assertIn("no-store", client.get(path).headers["cache-control"])
            self.assertEqual(
                client.get("/api/content/preferences").json()["revision"], 0
            )
            self.assertEqual(
                client.put(
                    "/api/content/preferences", json={"folded": ["root"], "revision": 0}
                ).status_code,
                200,
            )
            self.assertEqual(
                client.get("/api/content/preferences").json()["folded"], ["root"]
            )

    def test_save_requires_destination_and_reuses_saved_id(self):
        from api.models.content import DashboardSave
        from api.platform.content_dashboard import save_dashboard

        folder = self.owner.create("folder", "Reports")
        with patch("api.platform.content.personal_store", return_value=self.store):
            with self.assertRaises(HTTPException):
                save_dashboard(DashboardSave(name="Unnamed"))
            doc = save_dashboard(
                DashboardSave(name="Operations", parent_id=folder["id"])
            )
            updated = save_dashboard(
                DashboardSave(dashboard_id=doc["id"], revision=doc["revision"])
            )
            self.assertEqual(updated["id"], doc["id"])
            self.assertEqual(updated["parent_id"], folder["id"])
            self.assertEqual(updated["name"], "Operations")
            self.assertEqual(updated["revision"], doc["revision"] + 1)
            with self.assertRaises(HTTPException) as err:
                save_dashboard(
                    DashboardSave(dashboard_id=doc["id"], revision=doc["revision"])
                )
            self.assertEqual(err.exception.status_code, 409)

    def test_save_rolls_back_creation_for_unapproved_source(self):
        from api.models.content import DashboardSave
        from api.platform.content_dashboard import save_dashboard

        folder = self.owner.create("folder", "Reports")
        before = deepcopy(self.store.rows)
        with (
            patch("api.platform.content.personal_store", return_value=self.store),
            patch(
                "api.platform.content_dashboard.calculate",
                side_effect=HTTPException(409, "Review first"),
            ),
        ):
            with self.assertRaises(HTTPException):
                save_dashboard(
                    DashboardSave(
                        name="Report",
                        parent_id=folder["id"],
                        sources=[
                            {
                                "id": "revenue",
                                "revision": 1,
                                "dataset_id": "ops",
                                "version": 1,
                                "semantic_revision": 1,
                            }
                        ],
                    )
                )
        self.assertEqual(self.store.rows, before)

    def test_save_preserves_layout_and_enforces_shared_permissions(self):
        from api.models.content import DashboardSave
        from api.platform.content_dashboard import save_dashboard

        doc = self.owner.create("dashboard", "Report")
        source = dict(
            id="revenue", revision=1, dataset_id="ops", version=1, semantic_revision=1
        )
        widget = dict(
            id=uuid4().hex,
            source=source,
            digest="digest",
            width=3,
            title="Custom title",
        )
        doc["pages"][0]["widgets"] = [widget]
        doc = self.owner.save(doc, doc["revision"], "layout")
        with (
            patch("api.platform.content.personal_store", return_value=self.store),
            patch(
                "api.platform.content_dashboard.calculate",
                return_value={"digest": "digest"},
            ),
        ):
            saved = save_dashboard(
                DashboardSave(
                    dashboard_id=doc["id"], revision=doc["revision"], sources=[source]
                )
            )
            self.assertEqual(saved["pages"], doc["pages"])
            member = self.login("bob")
            member.register()
            self.owner.share(doc["id"], "bob", "view", saved["revision"])
            with self.assertRaises(HTTPException) as err:
                save_dashboard(
                    DashboardSave(
                        dashboard_id=doc["id"], revision=saved["revision"] + 1
                    )
                )
            self.assertEqual(err.exception.status_code, 403)

    def test_missing_binding_fails_without_opening_any_database(self):
        from api.platform.content_store import personal_store

        personal_store.cache_clear()
        self.addCleanup(personal_store.cache_clear)
        with (
            patch.dict("os.environ", {"VCAP_SERVICES": "{}"}),
            patch("api.platform.content_store.db_manager.get_connection") as connect,
        ):
            with self.assertRaises(HTTPException) as err:
                personal_store()
            self.assertEqual(err.exception.status_code, 503)
            self.assertIn("not bound to the API", err.exception.detail)
            connect.assert_not_called()

    def test_private_binding_uses_separate_credentials_and_verifies_isolation(self):
        import json
        from api.platform.content_store import personal_store

        personal_store.cache_clear()
        self.addCleanup(personal_store.cache_clear)
        binding = {
            "user-provided": [
                {
                    "name": "analytics-content-hana",
                    "credentials": {
                        "user": "CONTENT_RUNTIME",
                        "password": "test-only",
                        "schema": "PRIVATE_CONTENT",
                        "host": "hana.example",
                    },
                }
            ]
        }
        with (
            patch.dict(
                "os.environ",
                {
                    "VCAP_SERVICES": json.dumps(binding),
                    "CONTENT_HANA_SERVICE_NAME": "analytics-content-hana",
                },
            ),
            patch("api.platform.content_store.settings") as settings,
            patch("api.platform.content_store.HANAConnectionManager") as pool,
            patch("api.platform.content_store.verify_sql_console_isolation") as verify,
        ):
            settings.HANA_ADDRESS = "hana.example"
            settings.HANA_USER = "CONSOLE"
            settings.HANA_SCHEMA = "PLATFORM"
            self.assertEqual(personal_store().backend, "hana")
            verify.assert_called_once_with("PRIVATE_CONTENT")
            pool.assert_called_once_with(
                user="CONTENT_RUNTIME", password="test-only", schema="PRIVATE_CONTENT"
            )

    def test_console_access_blocks_private_store(self):
        from api.platform.content_store import verify_sql_console_isolation

        with patch("api.platform.content_store.db_manager") as pool:
            with self.assertRaises(HTTPException) as err:
                verify_sql_console_isolation("Private")
            self.assertEqual(err.exception.status_code, 503)
            pool.return_connection.assert_called_once()

    def test_hana_transaction_rolls_back_and_restores_pool_state(self):
        from api.platform.content_store import PersonalStore

        pool = MagicMock()
        conn = pool.get_connection.return_value
        conn.getautocommit.return_value = True
        with self.assertRaises(HTTPException):
            with PersonalStore(pool).transaction():
                raise HTTPException(409, "Conflict")
        conn.rollback.assert_called_once()
        conn.commit.assert_not_called()
        self.assertEqual(
            [c.args for c in conn.setautocommit.call_args_list], [(False,), (True,)]
        )
        pool.return_connection.assert_called_once_with(conn)

    def setUp(self):
        self.store = DocumentFixture()
        self.owner = self.login("alice")

    def login(self, user, tenant="t", workspace="w", role="Member"):
        token = current_identity.set(
            dict(user_id=user, tenant_id=tenant, workspace_id=workspace, role=role)
        )
        self.addCleanup(current_identity.reset, token)
        return ContentWorkspace(self.store)

    def test_sqlite_is_refused_before_any_io(self):
        with patch.object(MetadataStore, "transaction", side_effect=AssertionError):
            with self.assertRaises(HTTPException) as err:
                ContentWorkspace(MetadataStore(backend="sqlite"))
        self.assertEqual(err.exception.status_code, 503)

    def test_folder_move_cycle_name_conflict_and_subtree_restore(self):
        a = self.owner.create("folder", " Alpha ")
        b = self.owner.create("folder", "Beta", parent_id=a["id"])
        d = self.owner.create("dashboard", "Weekly", parent_id=b["id"])
        for action in (
            lambda: self.owner.change(a["id"], 1, {"parent_id": b["id"]}),
            lambda: self.owner.create("folder", "ALPHA"),
        ):
            with self.assertRaises(HTTPException) as err:
                action()
            self.assertEqual(err.exception.status_code, 409)
        self.owner.change(a["id"], 1, {"deleted": True})
        self.assertEqual(self.owner.tree(), [])
        self.owner.change(a["id"], 2, {"deleted": False})
        self.assertEqual(self.owner.get(d["id"])["parent_id"], b["id"])
        self.owner.change(d["id"], 1, {"parent_id": None, "name": "Report"})
        with self.assertRaises(HTTPException):
            self.owner.change(d["id"], 1, {"name": "Lost edit"})
        self.assertEqual(self.owner.get(d["id"])["name"], "Report")

    def test_archive_and_personal_activity_remain_authorized(self):
        folder = self.owner.create("folder", "Team")
        doc = self.owner.create("dashboard", "Report", parent_id=folder["id"])
        self.owner.mark(doc["id"], favourite=True)
        self.owner.mark(doc["id"])
        entry = next(i for i in self.owner.tree() if i["id"] == doc["id"])
        self.assertTrue(entry["favourite"])
        self.assertTrue(entry["last_opened"])
        self.owner.change(folder["id"], 1, {"archived": True})
        self.assertEqual(self.owner.tree(), [])
        self.assertEqual(self.owner.tree(archived=True)[0]["id"], folder["id"])
        self.owner.change(folder["id"], 2, {"archived": False})
        self.assertEqual(len(self.owner.tree()), 2)
        with self.assertRaises(HTTPException):
            self.login("other").mark(doc["id"])

    def test_private_admin_tenant_workspace_sharing_and_revocation(self):
        d = self.owner.create("dashboard", "Private")
        for user in (
            self.login("alice", "other"),
            self.login("alice", workspace="elsewhere"),
            self.login("admin", role="Admin"),
        ):
            self.assertEqual(user.tree(), [])
            with self.assertRaises(HTTPException):
                user.resolve(d["id"])
        bob = self.login("bob")
        bob.register()
        self.owner.share(d["id"], "bob", "view", 1)
        self.assertEqual(bob.tree()[0]["permission"], "view")
        with self.assertRaises(HTTPException):
            bob.resolve(d["id"], write=True)
        self.owner.share(d["id"], "bob", "edit", 2)
        self.assertEqual(bob.resolve(d["id"], write=True).permission, "edit")
        self.owner.share(d["id"], "bob", "revoke", 3)
        with self.assertRaises(HTTPException):
            bob.resolve(d["id"])

    def test_two_source_results_atomic_publication_retry_pin_and_revocation(self):
        service = MagicMock()
        service.repository.store = self.store
        service.repository.objects.backend = "hana"
        catalog = {"datasets": {}}
        service._catalog.return_value = catalog
        service._entry.side_effect = DatasetService._entry
        service._snapshot.side_effect = lambda entry, version: {
            "columns": [{"name": "units", "type": "number"}],
            "rows": [{"units": entry["total"] * version}],
        }
        refs = []
        for dataset, total in (("operations", 21), ("inventory", 47)):
            entry = dict(
                id=dataset,
                workspaceId="w",
                ownerId="alice",
                currentVersion=1,
                total=total,
            )
            catalog["datasets"][dataset] = entry
            model = dict(
                dataset_id=dataset,
                data_version=1,
                revision=1,
                status="approved",
                grain="one observation",
                fields=[
                    dict(
                        name="units",
                        semantic_name="Units",
                        type="integer",
                        role="measure",
                        aggregations=["SUM"],
                    )
                ],
            )
            self.store.put(semantic_registry.namespace(entry, 1), "1", model)
            ns = semantic_registry.namespace(entry, 1, "analytics:1")
            item = dict(
                id="count",
                revision=1,
                title="Units",
                kind="kpi",
                semantic_revision=1,
                status="approved",
                reviewer="alice",
                query_plan={"metric": "units", "aggregation": "SUM"},
                dependencies=["units"],
                explanation="Reviewed",
            )
            self.store.put(ns, "count:1", item)
            refs.append(
                dict(
                    id="count",
                    revision=1,
                    dataset_id=dataset,
                    version=1,
                    semantic_revision=1,
                )
            )
        doc = self.owner.create("dashboard", "Metrics")
        args = dict(page_id=doc["pages"][0]["id"], revision=1, request_id=uuid4())
        with patch("api.platform.content_publication.dataset_service", service):
            for status, reviewer in (
                ("proposed", None),
                ("rejected", "alice"),
                ("approved", "system"),
            ):
                row = self.store.get(ns, "count:1")
                self.store.put(
                    ns,
                    "count:1",
                    dict(item, status=status, reviewer=reviewer),
                    row["revision"],
                )
                with self.assertRaises(HTTPException):
                    publish(self.owner, doc["id"], Publication(**args, sources=refs))
                self.assertEqual(self.owner.get(doc["id"])["revision"], 1)
            self.store.put(
                ns, "count:1", item, self.store.get(ns, "count:1")["revision"]
            )
            req = Publication(**args, sources=refs)
            receipt = publish(self.owner, doc["id"], req)
            self.assertEqual(receipt, publish(self.owner, doc["id"], req))
            self.assertEqual(receipt["placements_written"], 2)
            from api.models.content import FilterEdit
            from api.platform.content_dashboard import edit_filters, refresh

            page = self.owner.get(doc["id"])["pages"][0]
            with patch("api.platform.content.personal_store", return_value=self.store):
                edit_filters(
                    doc["id"],
                    FilterEdit(
                        revision=2,
                        placement_id=page["widgets"][0]["id"],
                        scope="dashboard",
                        filters=[{"column": "units", "operator": ">", "value": 100}],
                    ),
                )
                filtered = refresh(doc["id"], page["id"])["widgets"]
                self.assertEqual(
                    filtered[page["widgets"][0]["id"]]["result"]["records_matched"], 0
                )
                self.assertEqual(
                    filtered[page["widgets"][1]["id"]]["result"]["summary"]["value"], 47
                )
            entry["currentVersion"] = 2
            values = [
                calculate(self.owner, ref)["result"]["summary"]["value"] for ref in refs
            ]
            self.assertEqual(values, [21, 47])
            with self.assertRaises(HTTPException):
                calculate(self.owner, refs[-1], publishing=True)
            entry["ownerId"] = "other"
            with self.assertRaises(HTTPException) as err:
                calculate(self.owner, refs[-1])
            self.assertEqual(err.exception.status_code, 403)
