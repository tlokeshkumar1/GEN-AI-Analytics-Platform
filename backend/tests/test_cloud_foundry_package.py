"""The CF gate rejects broken artifacts and packaged private configuration."""

import copy
import io
import importlib.util
import unittest
from pathlib import Path
from zipfile import ZipFile

import yaml

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "check_cloud_foundry", ROOT / "scripts/check_cloud_foundry.py"
)
package_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package_check)
validate_archive = package_check.validate_archive
validate_descriptor = package_check.validate_descriptor


class CloudFoundryPackageTests(unittest.TestCase):
    def setUp(self):
        self.descriptor = yaml.safe_load((ROOT / "mta.yaml").read_text())

    def archive(self, *, omit_ui=False, private_module=None, private_outer=False):
        descriptor = copy.deepcopy(self.descriptor)
        output = io.BytesIO()
        with ZipFile(output, "w") as archive:
            for module in descriptor["modules"]:
                if module["name"].endswith("-ui"):
                    continue
                suffix = module["name"].rsplit("-", 1)[-1]
                module["path"] = module["name"]
                payload = io.BytesIO()
                with ZipFile(payload, "w") as files:
                    names = [
                        "api/app.py",
                        "api/worker.py",
                        "requirements.txt",
                        "Procfile",
                    ]
                    if suffix == "router":
                        names = ["xs-app.json", "resources/assets/main.js"]
                        if not omit_ui:
                            names.append("resources/index.html")
                    for name in names:
                        files.writestr(name, "fixture")
                    if suffix == private_module:
                        files.writestr("default-env.json", "synthetic fixture")
                archive.writestr(f"{module['path']}/data.zip", payload.getvalue())
            archive.writestr("META-INF/mtad.yaml", yaml.safe_dump(descriptor))
            if private_outer:
                archive.writestr("deployment.private.mtaext", "synthetic fixture")
        output.seek(0)
        return output

    def test_valid_modules_and_built_ui_pass(self):
        validate_descriptor(self.descriptor)
        validate_archive(self.archive())

    def test_missing_frontend_build_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "frontend index missing"):
            validate_archive(self.archive(omit_ui=True))

    def test_private_configs_are_rejected_in_every_runtime_module(self):
        for module in ("api", "worker", "router"):
            with (
                self.subTest(module=module),
                self.assertRaisesRegex(ValueError, "Private configuration"),
            ):
                validate_archive(self.archive(private_module=module))

    def test_private_extensions_are_rejected_at_archive_root(self):
        with self.assertRaisesRegex(ValueError, "Private configuration"):
            validate_archive(self.archive(private_outer=True))

    def test_worker_public_route_and_missing_hana_binding_are_rejected(self):
        prefix = self.descriptor["ID"]
        worker = next(
            m for m in self.descriptor["modules"] if m["name"] == f"{prefix}-worker"
        )
        worker["parameters"]["no-route"] = False
        with self.assertRaisesRegex(ValueError, "no public route"):
            validate_descriptor(self.descriptor)
        worker["parameters"]["no-route"] = True
        worker["requires"] = [
            r for r in worker["requires"] if r["name"] != f"{prefix}-hdi-container"
        ]
        with self.assertRaisesRegex(ValueError, "HANA binding missing"):
            validate_descriptor(self.descriptor)


if __name__ == "__main__":
    unittest.main()
