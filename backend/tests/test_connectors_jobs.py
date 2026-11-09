"""Provider contracts and recovery tests never contact live infrastructure."""
import copy
import io
import json
import sys
import tempfile
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cryptography.fernet import Fernet
from fastapi import HTTPException
from api.models.execution_context import current_identity
from api.platform.ai_settings import current_ai_settings
from api.platform.connectors import Batch, HTTPAdapter, ODataAdapter, S4HANAAdapter, SACAdapter, SOAPAdapter, HANAAdapter, ObjectAdapter, ConnectionSpec, identifier
from api.platform.connections import ConnectionService, CredentialStore
from api.platform.jobs import JobService
from api.platform.storage import ArtifactStore, DatasetRepository
from api.platform.store import MetadataStore
from api.services.dataset_service import DatasetService

AI = dict(llm_model="test", embedding_model="test", temperature=0.2, max_tokens=1500)


class ConnectorContracts(unittest.TestCase):
    def test_odata_delta_deletions_require_explicit_key_mapping(self):
        with patch("api.platform.connectors.requests.Session"):
            adapter = ODataAdapter({"base_url": "https://odata.test", "incremental": True})
            payload = {"value": [{"ID": "001", "@removed": {"reason": "deleted"}}], "@odata.deltaLink": "https://odata.test/delta"}
            with patch.object(adapter, "get", return_value=payload):
                with self.assertRaises(ValueError):
                    list(adapter.extract("Employees"))
                adapter.config.update(deletion_mapping={"EmployeeID": "ID"}, deletion_field="deleted")
                events = list(adapter.extract("Employees", {"delta_link": "https://odata.test/old-delta"}))
            self.assertEqual(events[0].records, [{"EmployeeID": "001", "deleted": True}])

    def test_sap_service_paths_and_tenant_failures_use_real_contracts(self):
        with patch("api.platform.connectors.requests.Session"):
            s4 = S4HANAAdapter({"base_url": "https://sap.test", "api_service": "sap/opu/odata/sap/API_BUSINESS_PARTNER"})
            with patch.object(s4, "get", return_value={"value": [{"ID": "001"}]}) as get:
                self.assertEqual(list(s4.extract("A_BusinessPartner"))[0].records[0]["ID"], "001")
                self.assertTrue(s4.base.endswith("/sap/opu/odata/sap/API_BUSINESS_PARTNER/"))
            sac = SACAdapter({"base_url": "https://sac.test", "namespace": "sac", "provider_id": "model-one"})
            with patch.object(sac, "get", return_value={"value": [{"Amount": "10.50"}]}) as get:
                list(sac.extract("FactData"))
                get.assert_called_once_with("providers/sac/model-one/FactData")
                with self.assertRaises(ValueError):
                    list(sac.extract("arbitrary-path"))

    def test_soap_named_operation_maps_records_and_closes_transport(self):
        with patch("api.platform.connectors.requests.Session") as session:
            adapter = SOAPAdapter({"base_url": "https://soap.test", "service_name": "HR", "port_name": "HTTPS", "records_path": "employees", "response_mapping": {"EmployeeID": "person.id", "Salary": "pay.amount"}})
            service, client = Mock(), Mock()
            service.__getitem__ = Mock(return_value=Mock(return_value={"employees": [{"person": {"id": "001"}, "pay": {"amount": "0.10"}}]}))
            client.bind.return_value = service
            with patch.object(adapter, "_client", return_value=client), patch.dict(sys.modules, {"zeep.helpers": types.SimpleNamespace(serialize_object=lambda value: value)}):
                rows = list(adapter.extract("ListEmployees"))[0].records
            self.assertEqual(rows, [{"EmployeeID": "001", "Salary": "0.10"}])
            client.bind.assert_called_once_with("HR", "HTTPS")
            adapter.close(); session.return_value.close.assert_called_once()

    def test_hana_parameterized_discovery_and_batched_extraction(self):
        adapter = HANAAdapter({"schema": 'HR"REVIEWED', "page_size": 2})
        conn, cursor = Mock(), Mock()
        conn.cursor.return_value = cursor
        cursor.description = [("EmployeeID",), ("Salary",)]
        cursor.fetchmany.side_effect = [[("001", "0.10"), ("002", None)], []]
        with patch.object(adapter, "_connect", return_value=conn):
            rows = list(adapter.extract("Employees"))[0].records
        self.assertEqual(rows[0]["EmployeeID"], "001")
        self.assertIsNone(rows[1]["Salary"])
        self.assertEqual(cursor.execute.call_args.args[0], 'SELECT * FROM "HR""REVIEWED"."Employees"')
        conn.close.assert_called_once()

    def test_object_sources_preserve_bytes_and_checkpoint_identity(self):
        for service in ("s3", "gcs", "azure_blob"):
            with self.subTest(service=service):
                adapter = ObjectAdapter({"object_service": service, "bucket": "source"})
                client = Mock()
                content = b"ID,Amount\n001,0.10\n"
                if service == "s3":
                    client.get_object.return_value = {"ETag": "etag-one", "Body": io.BytesIO(content)}
                elif service == "gcs":
                    blob = client.bucket.return_value.get_blob.return_value
                    blob.etag = "etag-one"; blob.generation = 7; blob.download_as_bytes.return_value = content
                else:
                    blob = client.get_blob_client.return_value
                    blob.get_blob_properties.return_value.etag = "etag-one"
                    blob.download_blob.return_value.readall.return_value = content
                with patch.object(adapter, "_client", return_value=client), patch.dict(sys.modules, {"azure.core": types.SimpleNamespace(MatchConditions=types.SimpleNamespace(IfNotModified="condition"))}):
                    batches = list(adapter.extract("data.csv"))
                self.assertEqual(batches[0].content, content)
                self.assertEqual(batches[0].checkpoint, {"etag": "etag-one"})
                client.close.assert_called_once()

    def test_rest_next_links_and_no_credential_forwarding_to_other_origin(self):
        with patch("api.platform.connectors.requests.Session") as factory:
            first, last = Mock(), Mock()
            first.json.return_value = {"records": [{"ID": "001"}], "next": "/api/page2"}
            last.json.return_value = {"records": [{"ID": "002"}], "next": None}
            first.status_code = last.status_code = 200
            factory.return_value.get.side_effect = [first, last]
            adapter = HTTPAdapter({"base_url": "https://example.test/api/", "pagination": "next_link", "records_path": "records"})
            self.assertEqual([row["ID"] for batch in adapter.extract("page1") for row in batch.records], ["001", "002"])
            first.json.return_value["next"] = "https://untrusted.test/leak"
            factory.return_value.get.side_effect = [first]
            with self.assertRaises(ValueError):
                list(adapter.extract("page1"))
            self.assertEqual(factory.return_value.get.call_args.args[0], "https://example.test/api/page1")

    def test_odata_v2_v4_metadata_and_pagination(self):
        with patch("api.platform.connectors.requests.Session") as factory:
            a, b, metadata = Mock(), Mock(), Mock()
            a.status_code = b.status_code = metadata.status_code = 200
            a.json.return_value = {"d": {"results": [{"ID": "A"}], "__next": "https://example.test/odata/next"}}
            b.json.return_value = {"value": [{"ID": "B"}], "@odata.deltaLink": "https://example.test/odata/delta"}
            metadata.content = b'<Edmx xmlns="urn:test"><EntitySet Name="Employees" EntityType="HR.Employee" /></Edmx>'
            factory.return_value.get.side_effect = [metadata, a, b]
            adapter = ODataAdapter({"base_url": "https://example.test/odata/"})
            self.assertEqual(adapter.discover()["entities"][0]["name"], "Employees")
            batches = list(adapter.extract("Employees"))
            self.assertEqual([row["ID"] for batch in batches for row in batch.records], ["A", "B"])
            self.assertIn("delta_link", batches[-1].checkpoint)

    def test_provider_error_is_not_a_successful_connection_and_secrets_are_masked(self):
        with tempfile.TemporaryDirectory() as directory:
            store = MetadataStore(Path(directory) / "metadata.db", "sqlite")
            service = ConnectionService(store, CredentialStore(store, Fernet.generate_key()))
            token = current_identity.set({"workspace_id": "w", "user_id": "admin", "roles": ["Admin"]})
            try:
                spec = ConnectionSpec(name="Test", provider="generic", service="rest", protocol="https", auth_type="bearer",
                                      config={"base_url": "https://example.test"}, credentials={"token": "private-secret"})
                result = service.save(spec)
                self.assertNotIn("private-secret", json.dumps(result))
                self.assertNotIn("private-secret", json.dumps(store.list("w:credentials")))
                adapter = Mock()
                adapter.test.side_effect = RuntimeError("private-secret")
                with patch("api.platform.connections.open_connector", return_value=adapter):
                    with self.assertRaises(HTTPException) as exc:
                        service.test(result["id"])
                self.assertNotIn("private-secret", exc.exception.detail)
                self.assertNotEqual(service.list()[0]["verification"], "verified")
            finally:
                current_identity.reset(token)

    def test_database_identifier_quoting_never_accepts_sql_fragments_as_code(self):
        self.assertEqual(identifier('schema"; DROP TABLE X;--'), '"schema""; DROP TABLE X;--"')


class DurableDataAndJobs(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = MetadataStore(Path(self.temp.name) / "metadata.db", "sqlite")
        self.objects = ArtifactStore("local", Path(self.temp.name) / "objects")
        self.repository = DatasetRepository(self.store, self.objects, "w")
        self.datasets = DatasetService(Path(self.temp.name) / "cache", False, self.repository)
        self.addCleanup(self.datasets.wait_for_idle)
        self.identity = {"workspace_id": "w", "user_id": "owner", "roles": ["Admin"]}
        token = current_identity.set(self.identity); self.addCleanup(current_identity.reset, token)
        token = current_ai_settings.set(AI); self.addCleanup(current_ai_settings.reset, token)
        for name, value in [("_index", ([], "Error")), ("_submit_indexing", None)]:
            mock = patch.object(self.datasets, name, return_value=value)
            mock.start(); self.addCleanup(mock.stop)

    def test_durable_snapshot_restart_rollback_and_idempotency(self):
        first = self.datasets.upload(b"ID,Amount\n001,0.10\n", "data.csv", ingestion_id="first")
        self.datasets.upload(b"ID,Amount\n002,0.20\n", "data.csv", ingestion_id="second")
        restarted = DatasetService(Path(self.temp.name) / "new-empty-cache", False, DatasetRepository(self.store, self.objects, "w"))
        self.addCleanup(restarted.wait_for_idle)
        self.assertEqual(restarted.data(first["dataset"]["id"])["rows"][0]["ID"], "002")
        replay = restarted.upload(b"ID,Amount\n002,0.20\n", "data.csv", ingestion_id="second")
        self.assertEqual(replay["version"], 2)
        restarted.restore(first["dataset"]["id"], 1)
        self.assertEqual(restarted.data(first["dataset"]["id"])["rows"][0]["Amount"], "0.10")

    def test_failed_object_write_does_not_publish_a_version(self):
        first = self.datasets.upload(b"ID,Amount\n001,10\n", "data.csv")
        with patch.object(self.objects, "put", side_effect=RuntimeError("storage down")):
            with self.assertRaises(Exception):
                self.datasets.upload(b"ID,Amount\n002,20\n", "data.csv")
        self.assertEqual(self.datasets._catalog()["datasets"][first["dataset"]["id"]]["currentVersion"], 1)

    def test_durable_edited_excel_artifact_remains_an_actual_workbook(self):
        import pandas as pd
        buffer = io.BytesIO()
        pd.DataFrame({"ID": ["001"], "Amount": ["0.10"]}).to_excel(buffer, index=False)
        first = self.datasets.upload(buffer.getvalue(), "data.xlsx")
        dataset_id = first["dataset"]["id"]
        row = self.datasets.data(dataset_id)["rows"][0]
        exact = "0.200000000000000000001"
        result = self.datasets.mutate(dataset_id, "edit", [{"__rowId": row["__rowId"], "Amount": exact}], False)
        version = self.datasets._catalog()["datasets"][dataset_id]["versions"][-1]
        raw = self.objects.get(version["rawKey"])
        self.assertTrue(raw.startswith(b"PK"))
        self.assertEqual(str(pd.read_excel(io.BytesIO(raw), dtype=str).iloc[0]["Amount"]), exact)

    def test_upsert_normalizes_values_and_accepts_key_only_deletions(self):
        first = self.datasets.upload(b"ID,Amount\n001,0.10\n002,0.20\n", "source.csv")
        dataset_id = first["dataset"]["id"]
        result = self.datasets.ingest_rows(dataset_id, [{"ID": "001", "Amount": 0.10}, {"ID": "002", "deleted": True}],
                                           "upsert", "delta-one", "binding", ["ID"], deletion_field="deleted")
        self.assertEqual(result["version"], 2)
        self.assertEqual(self.datasets.data(dataset_id)["rows"][0]["Amount"], "0.10")
        metadata = self.datasets._catalog()["datasets"][dataset_id]["versions"][-1]
        self.assertEqual(metadata["counts"], dict(inserted=0, updated=0, deleted=1, unchanged=1))
        self.assertEqual(self.datasets.ingest_rows(dataset_id, [], "upsert", "delta-one", "binding", ["ID"])["version"], 2)
        with self.assertRaises(HTTPException):
            self.datasets.ingest_rows(dataset_id, [{"ID": "001", "Amount": "invalid"}], "upsert", "bad", "binding", ["ID"])
        self.assertEqual(self.datasets._catalog()["datasets"][dataset_id]["currentVersion"], 2)

    def test_invalid_deletion_flag_never_deletes_or_publishes(self):
        first = self.datasets.upload(b"ID,Amount\n001,0.10\n", "source.csv")
        dataset_id = first["dataset"]["id"]
        with self.assertRaises(HTTPException):
            self.datasets.ingest_rows(dataset_id, [{"ID": "001", "Amount": "0.10", "deleted": "false"}],
                                      "upsert", "invalid-delete", "binding", ["ID"], deletion_field="deleted")
        self.assertEqual(self.datasets._catalog()["datasets"][dataset_id]["currentVersion"], 1)

    def test_stale_editor_cannot_write_after_another_user_version(self):
        first = self.datasets.upload(b"ID,Amount\n001,0.10\n", "source.csv")
        dataset_id = first["dataset"]["id"]
        self.datasets.upload(b"ID,Amount\n001,0.20\n", "source.csv")
        with self.assertRaises(HTTPException) as exc:
            self.datasets.mutate(dataset_id, "append", [{"ID": "002", "Amount": "0.30"}], False, expected_version=1)
        self.assertEqual(exc.exception.status_code, 409)
        self.assertEqual(self.datasets._catalog()["datasets"][dataset_id]["currentVersion"], 2)

    def test_failure_keeps_checkpoint_and_retry_reuses_committed_receipt(self):
        binding_id = "binding"
        self.store.put("w:bindings", binding_id, dict(name="Source", connection_id="connection", source="Records", mode="replace", checkpoint={"old": 1}))
        connector = Mock()
        connector.extract.return_value = iter([Batch(records=[{"ID": "001", "Amount": "0.10"}], checkpoint={"new": 2})])
        connections = Mock()
        @contextmanager
        def opened(*args):
            yield connector
        connections.open = opened
        jobs = JobService(self.store, self.datasets, connections)
        job = jobs.enqueue("sync", {"binding_id": binding_id}, "request-one")
        original_put = self.store.put
        failed = [False]
        def put(namespace, key, value, expected_revision=0):
            if namespace == "w:bindings" and value.get("last_ingestion_id") and not failed[0]:
                failed[0] = True
                raise HTTPException(503, "Simulated checkpoint storage failure")
            return original_put(namespace, key, value, expected_revision)
        with patch.object(self.store, "put", side_effect=put):
            jobs.run_next("w")
        self.assertEqual(jobs.get(job["id"])["value"]["state"], "failed")
        self.assertEqual(self.store.get("w:bindings", binding_id)["value"]["checkpoint"], {"old": 1})
        before = copy.deepcopy(self.datasets._catalog())
        jobs.retry(job["id"])
        jobs.run_next("w")
        self.assertEqual(jobs.get(job["id"])["value"]["state"], "succeeded")
        self.assertEqual(self.store.get("w:bindings", binding_id)["value"]["checkpoint"], {"new": 2})
        self.assertEqual(self.datasets._catalog(), before)
        self.assertEqual(connector.extract.call_count, 1)

    def test_expired_job_is_recovered_and_queued_job_can_be_cancelled(self):
        first = self.datasets.upload(b"ID,Amount\n001,10\n", "data.csv")
        jobs = JobService(self.store, self.datasets)
        item = jobs.enqueue("index", {"dataset_id": first["dataset"]["id"], "version": 1}, "recover-index")
        record = jobs.get(item["id"])
        self.store.put("w:jobs", item["id"], {**record["value"], "state": "running", "worker": "dead-process", "lease_until": 0}, record["revision"])
        jobs.run_next("w")
        self.assertEqual(jobs.get(item["id"])["value"]["attempts"], 1)
        self.assertEqual(jobs.get(item["id"])["value"]["state"], "failed")
        item = jobs.enqueue("index", {"dataset_id": first["dataset"]["id"], "version": 1}, "cancel-index")
        jobs.cancel(item["id"])
        self.assertEqual(jobs.get(item["id"])["value"]["state"], "cancelled")


if __name__ == "__main__":
    unittest.main()
