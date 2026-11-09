import sys
sys.path.insert(0, 'backend')
from api.database.hana_client import hana_client

query = """
SELECT DISTINCT SUBSTRING_REGEXPR('^[^:]+' IN ID) AS DATASET_ID, COUNT(*) AS CNT
FROM VECTOR_TABLE
GROUP BY SUBSTRING_REGEXPR('^[^:]+' IN ID)
"""
try:
    res = hana_client.execute_query(query)
    print('Datasets in HANA VECTOR_TABLE:', res)
except Exception as e:
    # fallback
    res = hana_client.execute_query("SELECT TOP 20 ID FROM VECTOR_TABLE")
    print('Sample IDs:', [r['ID'] for r in res])

