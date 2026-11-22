#!/bin/bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
private_extension="${PRIVATE_MTA_EXTENSION:-deployment.private.mtaext}"
if [[ ! -f "$private_extension" ]]; then
  echo "Missing private MTA extension: $private_extension. Configure the shared HANA runtime user and schema before deployment." >&2
  exit 1
fi

echo "=== Building GEN-AI Analytics Platform MTA Package ==="
mbt build -t ./

echo "=== Deploying to SAP BTP Cloud Foundry ==="
cf deploy gen-ai-analytics-platform_1.0.0.mtar -e "$private_extension"
