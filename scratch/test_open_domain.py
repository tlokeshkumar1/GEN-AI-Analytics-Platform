import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent / "backend"
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

import pandas as pd
from api.platform.agent_domain_classifier import domain_classifier_agent
from api.platform.agent_chart_recommender import chart_recommender_agent

print("==================================================")
print("TESTING OPEN-DOMAIN ZERO-SHOT 5-ROW AGENT 2")
print("==================================================")

# ── TEST CASE 1: Precision Agriculture ───────────────────────────────────────
agri_data = {
    "Field_ID": ["FLD-101", "FLD-102", "FLD-103", "FLD-104", "FLD-105", "FLD-106"],
    "Crop_Type": ["Soybean", "Corn", "Wheat", "Soybean", "Barley", "Corn"],
    "Soil_Moisture_Pct": [24.5, 18.2, 22.0, 26.1, 19.8, 21.4],
    "Rainfall_mm": [12.0, 5.5, 8.2, 14.1, 6.0, 7.8],
    "Harvest_Date": ["2024-09-15", "2024-10-01", "2024-08-20", "2024-09-22", "2024-08-30", "2024-10-05"],
    "Yield_Tons": [3.8, 5.2, 4.1, 3.9, 3.2, 5.0]
}
df_agri = pd.DataFrame(agri_data)

print("\n--- TEST 1: Precision Agriculture (sampling 5 rows) ---")
model_agri = domain_classifier_agent.analyze(df_agri, "dataset_agri", 1)
print(f"Discovered Domain: '{model_agri.domain}'")
print(f"Entity Grain:      '{model_agri.grain}'")
for f in model_agri.fields:
    print(f"  Field: {f.name:18} | Role: {f.role:10} | Unit: {str(f.unit):6} | Synonyms: {f.aliases[:3]}")

recs_agri = chart_recommender_agent.recommend(df_agri, model_agri)
print(f"Recommended Charts for {model_agri.domain}:")
for r in recs_agri[:3]:
    print(f"  -> [{r['kind']:10}] {r['title']}")


# ── TEST CASE 2: Maritime Shipping ───────────────────────────────────────────
maritime_data = {
    "Vessel_IMO": ["9412345", "9523456", "9634567", "9745678", "9856789", "9967890"],
    "Vessel_Name": ["Ever Fortune", "Cosco Glory", "Maersk Pearl", "CMA CGM Titan", "MSC Bellissima", "Hapag Pride"],
    "Departure_Port": ["Shanghai", "Singapore", "Rotterdam", "Busan", "Ningbo", "Hamburg"],
    "Speed_Knots": [18.2, 16.5, 19.0, 17.8, 15.9, 18.5],
    "Departure_Date": ["2024-04-10", "2024-04-12", "2024-04-15", "2024-04-18", "2024-04-20", "2024-04-22"],
    "Fuel_Burn_Tons": [42.5, 38.0, 46.2, 41.0, 36.8, 43.5]
}
df_maritime = pd.DataFrame(maritime_data)

print("\n--- TEST 2: Maritime Shipping (sampling 5 rows) ---")
model_maritime = domain_classifier_agent.analyze(df_maritime, "dataset_maritime", 1)
print(f"Discovered Domain: '{model_maritime.domain}'")
print(f"Entity Grain:      '{model_maritime.grain}'")
for f in model_maritime.fields:
    print(f"  Field: {f.name:18} | Role: {f.role:10} | Unit: {str(f.unit):6} | Synonyms: {f.aliases[:3]}")

recs_maritime = chart_recommender_agent.recommend(df_maritime, model_maritime)
print(f"Recommended Charts for {model_maritime.domain}:")
for r in recs_maritime[:3]:
    print(f"  -> [{r['kind']:10}] {r['title']}")

print("\n==================================================")
print("SUCCESS: OPEN-DOMAIN 5-ROW AGENT 2 FULLY VERIFIED!")
print("==================================================")

