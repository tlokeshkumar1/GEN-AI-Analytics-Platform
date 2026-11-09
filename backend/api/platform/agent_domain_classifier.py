"""
Agent 2: Open-Domain 5-Row Semantic Intelligence Agent
=======================================================
Samples the first 5 rows of any uploaded/connected dataset and executes
unconstrained zero-shot LLM reasoning to discover the true domain, entity grain,
column roles (measures, dimensions, temporal axes, identifiers), and dynamic
contextual synonyms without any hardcoded taxonomy or domain lists.
"""

import json
import re
from typing import Dict, Any, List, Optional
import pandas as pd

from api.platform.contracts import SemanticField, SemanticModel
from api.services.ai_core_service import ai_core_service
from api.utils.logger import get_logger

logger = get_logger("agent.domain_classifier")

OPEN_DOMAIN_SYSTEM_PROMPT = """You are an expert enterprise ontologist and open-domain data scientist.
Analyze the following column profiles and the FIRST 5 ROWS of an unknown dataset.
Do not assume any pre-determined domain or business category. Infer the true domain directly from the data.

COLUMNS:
{columns_summary}

FIRST 5 SAMPLE ROWS:
{sample_rows_json}

Return ONLY a valid JSON object with this exact JSON structure:
{{
  "domain": "Specific free-form domain or industry name (e.g., Precision Agriculture, Maritime Shipping, Video Game Telemetry, Commercial Real Estate, Clinical Trials, Aviation Logistics)",
  "grain": "What a single row represents (e.g., One vessel waypoint ping, One harvest batch, One patient test record)",
  "column_annotations": {{
    "<exact_column_name>": {{
      "semantic_name": "Human-friendly label",
      "role": "measure" or "dimension" or "time" or "identifier",
      "default_aggregation": "SUM" or "AVG" or "COUNT" or "COUNT_DISTINCT" or null,
      "unit": "e.g. kg, liters, km/h, %, knots, ms, or null",
      "currency": "e.g. USD, EUR, or null",
      "description": "Short business explanation of this column",
      "synonyms": ["3 to 5 natural language synonyms or search phrases a domain specialist would ask in chat"]
    }}
  }}
}}
"""


class DomainClassifierAgent:
    """
    Open-domain semantic intelligence agent.
    Samples the first 5 rows to discover any domain dynamically with zero hardcoding.
    """

    def analyze(self, df: pd.DataFrame, dataset_id: str = "dataset", data_version: int = 1) -> SemanticModel:
        """
        Analyze the first 5 rows of clean DataFrame and construct an open-domain SemanticModel.
        """
        if df is None or df.empty:
            return SemanticModel(
                dataset_id=dataset_id,
                data_version=data_version,
                revision=1,
                domain="Enterprise",
                fields=[],
                status="proposed"
            )

        # 1. Extract exactly the first 5 rows as representative samples
        sample_rows = df.head(5).to_dict(orient="records")
        columns = list(df.columns)

        # 2. Build column profiling summary for the prompt
        col_profiles = []
        for col in columns:
            series = df[col]
            dtype = str(series.dtype)
            nunique = int(series.nunique())
            samples = [str(r.get(col)) for r in sample_rows]
            col_profiles.append(f"- {col} (type: {dtype}, distinct: {nunique}, samples: {samples[:3]})")
        columns_summary = "\n".join(col_profiles)

        # 3. Call Open-Domain Zero-Shot LLM Reasoning
        llm_result = self._query_open_domain_llm(columns_summary, sample_rows)

        domain = "Enterprise"
        grain = "Single record"
        annotations: Dict[str, Any] = {}

        if llm_result:
            domain = str(llm_result.get("domain") or "Enterprise").strip()
            grain = str(llm_result.get("grain") or "Single record").strip()
            annotations = llm_result.get("column_annotations", {})

        # If LLM didn't produce a domain, infer a clean domain name from column tokens
        if not domain or domain.lower() in ("unknown", "generic", "dataset"):
            domain = self._fallback_domain_name(columns)

        # 4. Construct SemanticFields by combining LLM annotations with physical type safety
        fields: List[SemanticField] = []
        for col in columns:
            series = df[col]
            ann = annotations.get(col, {})
            field = self._build_semantic_field(col, series, ann, sample_rows)
            fields.append(field)

        model = SemanticModel(
            dataset_id=dataset_id,
            data_version=data_version,
            revision=1,
            domain=domain,
            table_id=f"DS_{dataset_id}_V{data_version}",
            grain=grain,
            fields=fields,
            status="proposed"
        )

        logger.info(f"[DomainClassifierAgent] Open-domain discovered: '{domain}' (Grain: '{grain}') with {len(fields)} fields.")
        return model

    def _query_open_domain_llm(self, columns_summary: str, sample_rows: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """Query LLM for zero-shot open-domain reasoning using the first 5 rows."""
        try:
            sample_json = json.dumps(sample_rows[:5], indent=2, default=str)
            prompt = OPEN_DOMAIN_SYSTEM_PROMPT.format(
                columns_summary=columns_summary,
                sample_rows_json=sample_json
            )

            response = ai_core_service.generate_nvidia_completion(prompt)
            if not response or not response.strip():
                return None

            # Extract JSON from response
            text = response.strip()
            # Try direct JSON parse
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                pass

            # Try markdown code block
            json_match = re.search(r'```(?:json)?\s*(\{[\s\S]*?\})\s*```', text)
            if json_match:
                try:
                    return json.loads(json_match.group(1))
                except json.JSONDecodeError:
                    pass

            # Try finding first { ... } block
            brace_match = re.search(r'\{[\s\S]*\}', text)
            if brace_match:
                try:
                    return json.loads(brace_match.group(0))
                except json.JSONDecodeError:
                    pass

        except Exception as exc:
            logger.warning(f"[DomainClassifierAgent] Open-domain LLM call error: {exc}")

        return None

    def _build_semantic_field(
        self,
        col: str,
        series: pd.Series,
        ann: Dict[str, Any],
        sample_rows: List[Dict[str, Any]]
    ) -> SemanticField:
        """Construct a validated SemanticField honoring physical type constraints."""
        col_lower = col.lower()
        samples = [row.get(col) for row in sample_rows]

        # 1. Date / Time detection
        is_date = (
            any(k in col_lower for k in ["date", "time", "timestamp", "year", "month", "day", "created", "updated"]) or
            pd.api.types.is_datetime64_any_dtype(series) or
            ann.get("role") == "time"
        )

        # 2. Identifier detection
        is_id = not is_date and (
            col_lower.endswith(("id", "code", "key", "number", "num")) or
            col_lower in ("id", "key", "code") or
            ann.get("role") == "identifier" or
            (len(series.dropna()) > 0 and series.nunique() / len(series.dropna()) >= 0.98 and not pd.api.types.is_numeric_dtype(series))
        ) and col_lower not in ("month_num", "monthnum", "quarter_num")

        # 3. Numeric measure detection
        is_numeric = pd.api.types.is_numeric_dtype(series) and not is_id and not is_date

        if is_date:
            col_type = "date"
            role = "time"
            aggregations = ["COUNT", "COUNT_DISTINCT"]
            default_agg = None
        elif is_id:
            col_type = "identifier"
            role = "identifier"
            aggregations = ["COUNT", "COUNT_DISTINCT"]
            default_agg = "COUNT_DISTINCT"
        elif is_numeric:
            col_type = "decimal" if pd.api.types.is_float_dtype(series) else "integer"
            role = "measure"
            # If rate or percent, average rather than sum
            is_rate = any(w in col_lower for w in ["percent", "percentage", "pct", "ratio", "rate", "avg"])
            if is_rate or ann.get("default_aggregation") == "AVG":
                aggregations = ["AVG", "MIN", "MAX", "COUNT"]
                default_agg = "AVG"
            else:
                aggregations = ["SUM", "AVG", "MIN", "MAX", "COUNT"]
                default_agg = "SUM"
        else:
            col_type = "string"
            role = "dimension"
            aggregations = ["COUNT", "COUNT_DISTINCT"]
            default_agg = None

        # Display name & description
        display_name = ann.get("semantic_name") or col.replace("_", " ").title()
        description = ann.get("description") or f"{display_name} ({role})"

        # Physical unit & currency
        unit = ann.get("unit") or ("%" if any(w in col_lower for w in ["percent", "pct", "rate"]) else None)
        currency = ann.get("currency") or ("USD" if any(w in col_lower for w in ["usd", "price", "revenue", "cost", "salary", "amount"]) else None)

        # Dynamic Synonyms
        synonyms = set(ann.get("synonyms") or [])
        synonyms.add(col.lower())
        synonyms.add(display_name.lower())
        synonyms.add(col.lower().replace("_", " "))

        return SemanticField(
            name=col,
            semantic_name=display_name,
            type=col_type,
            role=role,
            aliases=sorted(list(synonyms)),
            description=description,
            unit=unit,
            currency=currency,
            aggregations=aggregations,
            default_aggregation=default_agg,
            evidence=f"Inferred from 5-row sample: {samples[:3]}"
        )

    def _fallback_domain_name(self, columns: List[str]) -> str:
        """Derive clean domain name from column names if LLM is offline."""
        tokens = [c.replace("_", " ").title() for c in columns[:3]]
        return f"{tokens[0]} Analytics" if tokens else "Enterprise Analytics"


domain_classifier_agent = DomainClassifierAgent()
