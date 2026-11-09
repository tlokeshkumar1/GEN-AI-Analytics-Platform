#!/bin/bash
echo "=== Building GEN-AI Analytics Platform MTA Package ==="
mbt build -t ./

echo "=== Deploying to SAP BTP Cloud Foundry ==="
cf deploy GEN-AI-Analytics-Platform_1.0.0.mtar
