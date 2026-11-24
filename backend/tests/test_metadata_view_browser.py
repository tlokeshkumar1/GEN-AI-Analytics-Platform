import unittest
from unittest.mock import Mock, patch
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from api.services.metadata_views import browse_views
from api.routes import hanaadmin


class MetadataViewBrowserTests(unittest.TestCase):
    def test_unknown_identifiers_are_rejected_before_database_access(self):
        with patch("api.services.metadata_views.db_manager.get_connection") as connect:
            with self.assertRaises(HTTPException) as caught:
                browse_views("PM_ANALYTICS_V; DROP TABLE PLATFORM_METADATA")
        self.assertEqual(caught.exception.status_code, 404)
        connect.assert_not_called()

    def test_page_is_bounded_and_lob_preview_is_limited(self):
        connection = Mock()
        cursor = connection.cursor.return_value
        cursor.fetchall.side_effect = [
            [("PM_SEMANTIC_MODELS_V",)],
            [("default:semantic:ds:v1", "id", 1, "x" * 20000)],
        ]
        cursor.fetchone.return_value = (30,)
        with (
            patch(
                "api.services.metadata_views.db_manager.get_connection",
                return_value=connection,
            ),
            patch(
                "api.services.metadata_views.db_manager.return_connection"
            ) as release,
        ):
            result = browse_views("PM_SEMANTIC_MODELS_V", 2, 25)
        self.assertEqual(result["totalRows"], 30)
        self.assertEqual(len(result["rows"][0]["payload"]), 16000)
        self.assertTrue(result["rows"][0]["truncated"])
        self.assertEqual(cursor.execute.call_args.args[1], (25, 25))
        cursor.close.assert_called_once()
        release.assert_called_once_with(connection)

    def test_routes_enforce_admin_and_page_validation(self):
        app = FastAPI()
        app.include_router(hanaadmin.router)
        client = TestClient(app)
        with patch.object(
            hanaadmin, "require_admin", side_effect=HTTPException(403, "Admin required")
        ):
            self.assertEqual(client.get("/api/hanaadmin/views").status_code, 403)
            self.assertEqual(
                client.get("/api/hanaadmin/views/PM_ANALYTICS_V/data").status_code, 403
            )
        with patch.object(hanaadmin, "require_admin"):
            self.assertEqual(
                client.get(
                    "/api/hanaadmin/views/PM_ANALYTICS_V/data?page=0"
                ).status_code,
                422,
            )

    def test_publication_filters_use_scoped_widget_reference_and_definition_revision(
        self,
    ):
        import json

        for filter_name in ("all", "published", "unpublished"):
            with self.subTest(filter=filter_name):
                connection = Mock()
                cursor = connection.cursor.return_value
                namespace = "default:analytics:1:ds-one:v1"
                cursor.fetchall.side_effect = [
                    [("PM_ANALYTICS_V",), ("PM_DASHBOARDS_V",)],
                    [
                        (
                            "default:dashboard:1:ds-one:v1",
                            json.dumps({"items": [{"id": "same", "revision": 2}]}),
                        )
                    ],
                    [
                        (namespace, "same:2", 9, "{}"),
                        (namespace, "same:1", 1, "{}"),
                        ("default:analytics:1:ds-two:v1", "same:2", 1, "{}"),
                    ],
                ]
                cursor.fetchone.side_effect = [(3,), (1,)]
                with (
                    patch(
                        "api.services.metadata_views.db_manager.get_connection",
                        return_value=connection,
                    ),
                    patch("api.services.metadata_views.db_manager.return_connection"),
                ):
                    result = browse_views("PM_ANALYTICS_V", 1, 25, filter_name)
                self.assertEqual(
                    result["publicationCounts"],
                    {"all": 3, "published": 1, "unpublished": 2},
                )
                self.assertEqual(
                    [r["published"] for r in result["rows"]], [True, False, False]
                )
                sql, parameters = cursor.execute.call_args.args
                if filter_name == "unpublished":
                    self.assertIn("WHERE NOT", sql)
                if filter_name != "all":
                    self.assertEqual(parameters[:2], (namespace, "same:2"))
