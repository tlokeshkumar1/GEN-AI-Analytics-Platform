"""
Agent 2: Open-Domain 5-Row Semantic Intelligence Agent
=======================================================
Samples the first 5 rows of any uploaded/connected dataset and executes
unconstrained zero-shot LLM reasoning to discover the true domain, entity grain,
column roles (measures, dimensions, temporal axes, identifiers), and dynamic
contextual synonyms without any hardcoded taxonomy or domain lists.
"""

from decimal import Decimal
import json
import re
from typing import Any, Dict, List, Optional, Tuple
import pandas as pd

from api.platform.contracts import SemanticField, SemanticModel
from api.services.ai_core_service import ai_core_service
from api.utils.logger import get_logger

logger = get_logger("agent.domain_classifier")

OPEN_DOMAIN_SYSTEM_PROMPT = """You are an expert enterprise ontologist and open-domain data scientist.
Analyze the dataset title, column profiles, and the FIRST 5 ROWS of an unknown dataset.
Do not assume any pre-determined domain or business category. Infer the true domain directly from the data.

DATASET NAME / SOURCE: {dataset_name}

COLUMNS:
{columns_summary}

FIRST 5 SAMPLE ROWS:
{sample_rows_json}

Return ONLY a valid JSON object (no markdown commentary, no thinking tags) with this exact structure:
{{
  "domain": "Specific domain or subject area inferred from the dataset name, column headers, and sample rows (never return 'Enterprise' or 'Unknown')",
  "grain": "What a single row or record in this dataset represents",
  "column_annotations": {{
    "<exact_column_name>": {{
      "semantic_name": "Human-friendly label",
      "role": "measure" or "dimension" or "time" or "identifier",
      "default_aggregation": "SUM" or "AVG" or "COUNT" or "COUNT_DISTINCT" or null,
      "unit": "Measured unit inferred from column/values (or null)",
      "currency": "Currency code if monetary column (or null)",
      "description": "Concise 1-sentence description grounded in this dataset",
      "synonyms": ["2 to 4 natural language synonyms relevant to this column"]
    }}
  }}
}}
"""


def _split_identifier_tokens(name: str) -> List[str]:
    """Split snake_case, kebab-case, and camelCase column names into lowercase tokens."""
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(name or ""))
    return [tok.lower() for tok in re.findall(r"[A-Za-z]+|\d+", spaced) if tok]


def _inspect_numeric_series(series: pd.Series) -> Tuple[bool, bool]:
    """
    Detect whether a Series (including object-dtype Decimal or formatted numeric strings)
    is numeric and whether it contains fractional/decimal values.
    Returns: (is_numeric, is_float_or_decimal)
    """
    if pd.api.types.is_bool_dtype(series):
        return False, False
    if pd.api.types.is_numeric_dtype(series):
        is_float = pd.api.types.is_float_dtype(series)
        if is_float:
            non_null = series.dropna()
            if not non_null.empty and all(float(v).is_integer() for v in non_null):
                return True, False
        return True, is_float

    non_null = series.dropna()
    if non_null.empty:
        return False, False

    if all(isinstance(v, (int, float, Decimal)) and not isinstance(v, bool) for v in non_null):
        has_decimal = any(
            isinstance(v, Decimal) and (v % 1 != 0) or isinstance(v, float) and not v.is_integer()
            for v in non_null
        )
        return True, has_decimal

    # Check formatted numeric strings (e.g., "$1,250.50", "18.5%")
    parsed_count = 0
    has_decimal = False
    for val in non_null.head(50):
        txt = str(val).strip()
        if not txt:
            continue
        cleaned = txt.replace(",", "").replace("$", "").replace("€", "").replace("£", "").rstrip("%").strip()
        try:
            num = float(cleaned)
            parsed_count += 1
            if not num.is_integer() or "." in cleaned:
                has_decimal = True
        except ValueError:
            return False, False
    sample_len = min(len(non_null), 50)
    return (sample_len > 0 and parsed_count == sample_len), has_decimal


def _looks_like_date_series(series: pd.Series, tokens: List[str]) -> bool:
    """Detect genuine temporal columns without hijacking duration measures or user-name columns."""
    if pd.api.types.is_datetime64_any_dtype(series):
        return True
    non_null = series.dropna()
    if non_null.empty:
        return False

    date_tokens = {"date", "datetime", "timestamp", "created", "updated", "month", "quarter", "year", "week"}
    duration_or_actor_tokens = {"days", "hours", "minutes", "seconds", "years", "months", "by", "downtime", "leadtime", "tenure", "age", "rate"}
    token_set = set(tokens)
    has_date_token = bool(token_set & date_tokens) or ("time" in token_set and not (token_set & duration_or_actor_tokens))
    if token_set & {"updated", "created"} and "by" in token_set:
        return False
    if token_set & duration_or_actor_tokens and not (token_set & {"date", "datetime", "timestamp"}):
        return False

    is_num, is_float = _inspect_numeric_series(non_null)
    if is_num:
        if is_float:
            return False
        # Only integer year/month columns with explicit year/month token and plausible calendar values
        nums = pd.to_numeric(non_null, errors="coerce").dropna()
        if "year" in token_set and not nums.empty and nums.between(1900, 2150).all():
            return True
        return False

    # String values: verify majority parse cleanly as calendar timestamps
    sample = non_null.head(30).astype(str).str.strip()
    if sample.empty:
        return False
    parsed = pd.to_datetime(sample, errors="coerce", format="mixed")
    valid_ratio = float(parsed.notna().mean())
    if valid_ratio >= 0.8 and (has_date_token or bool(sample.str.contains(r"[-/:T]", regex=True).mean() >= 0.8)):
        return True
    return has_date_token and valid_ratio >= 0.5


class DomainClassifierAgent:
    """
    Open-domain semantic intelligence agent.
    Samples the first 5 rows to discover any domain dynamically with zero hardcoding.
    """

    def analyze(
        self,
        df: pd.DataFrame,
        dataset_id: str = "dataset",
        data_version: int = 1,
        dataset_name: Optional[str] = None,
    ) -> SemanticModel:
        """
        Analyze the first 5 rows of clean DataFrame and construct an open-domain SemanticModel.
        """
        if df is None or df.empty:
            return SemanticModel(
                dataset_id=dataset_id,
                data_version=data_version,
                revision=1,
                domain=self._fallback_domain_name([], dataset_name),
                fields=[],
                status="proposed",
            )

        # 1. Extract exactly the first 5 rows as representative samples
        sample_rows = df.head(5).to_dict(orient="records")
        columns = list(df.columns)

        # 2. Build column profiling summary for the prompt
        col_profiles = []
        for col in columns:
            series = df[col]
            is_num, is_float = _inspect_numeric_series(series)
            dtype = "decimal" if (is_num and is_float) else "integer" if is_num else str(series.dtype)
            nunique = int(series.nunique())
            samples = [str(r.get(col)) for r in sample_rows]
            col_profiles.append(f"- {col} (type: {dtype}, distinct: {nunique}, samples: {samples[:3]})")
        columns_summary = "\n".join(col_profiles)

        # 3. Call Open-Domain Zero-Shot LLM Reasoning
        llm_result = self._query_open_domain_llm(columns_summary, sample_rows, dataset_name=dataset_name)

        domain = ""
        grain = "Single record"
        annotations: Dict[str, Any] = {}

        if isinstance(llm_result, dict):
            domain = str(llm_result.get("domain") or "").strip()
            grain = str(llm_result.get("grain") or "Single record").strip()
            raw_ann = llm_result.get("column_annotations")
            if isinstance(raw_ann, dict):
                annotations = raw_ann

        # Replace generic/empty domain names with a meaningful name inferred from source name & columns
        if not domain or domain.lower() in ("unknown", "generic", "dataset", "enterprise", "general", "n/a"):
            domain = self._fallback_domain_name(columns, dataset_name)

        # Case-insensitive annotation lookup map
        annotations_lower = {str(k).strip().lower(): v for k, v in annotations.items() if isinstance(v, dict)}

        # 4. Construct SemanticFields by combining LLM annotations with physical value checks
        fields: List[SemanticField] = []
        for col in columns:
            series = df[col]
            ann = annotations.get(col) or annotations_lower.get(str(col).strip().lower()) or {}
            if not isinstance(ann, dict):
                ann = {}
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
            status="proposed",
        )

        logger.info(
            f"[DomainClassifierAgent] Open-domain discovered: '{domain}' (Grain: '{grain}') with {len(fields)} fields."
        )
        return model

    def _query_open_domain_llm(
        self,
        columns_summary: str,
        sample_rows: List[Dict[str, Any]],
        dataset_name: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Query LLM for zero-shot open-domain reasoning using the first 5 rows."""
        try:
            sample_json = json.dumps(sample_rows[:5], indent=2, default=str)
            prompt = OPEN_DOMAIN_SYSTEM_PROMPT.format(
                dataset_name=dataset_name or "Uploaded Dataset",
                columns_summary=columns_summary,
                sample_rows_json=sample_json,
            )

            response = ai_core_service.generate_structured_completion(prompt, max_tokens=1800, temperature=0.1)
            if not response or not response.strip():
                return None

            return self._parse_json_response(response)
        except Exception as exc:
            logger.warning(f"[DomainClassifierAgent] Open-domain LLM call error: {exc}")

        return None

    @staticmethod
    def _parse_json_response(response: str) -> Optional[Dict[str, Any]]:
        """Strip reasoning tags/markdown fences and parse the first valid JSON object."""
        text = re.sub(r"<think>[\s\S]*?</think>", "", response, flags=re.IGNORECASE).strip()
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

        json_match = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", text)
        if json_match:
            try:
                parsed = json.loads(json_match.group(1))
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                pass

        brace_match = re.search(r"\{[\s\S]*\}", text)
        if brace_match:
            try:
                parsed = json.loads(brace_match.group(0))
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                pass
        return None

    def _build_semantic_field(
        self,
        col: str,
        series: pd.Series,
        ann: Dict[str, Any],
        sample_rows: List[Dict[str, Any]],
    ) -> SemanticField:
        """Construct a validated SemanticField honoring physical value constraints and LLM semantics."""
        col_lower = col.lower()
        tokens = _split_identifier_tokens(col)
        token_set = set(tokens)
        samples = [row.get(col) for row in sample_rows]
        llm_role = str(ann.get("role") or "").strip().lower()

        is_numeric, is_float = _inspect_numeric_series(series)
        is_date = _looks_like_date_series(series, tokens) or (llm_role == "time" and not (is_numeric and is_float))

        id_end_tokens = {"id", "uuid", "guid", "code", "key", "sku"}
        has_id_token = bool(tokens and tokens[-1] in id_end_tokens) or col_lower in ("id", "key", "code")
        non_null = series.dropna()
        high_uniqueness_text = (
            not is_numeric
            and len(non_null) >= 3
            and (non_null.nunique() / len(non_null)) >= 0.98
        )
        is_id = not is_date and (
            has_id_token
            or (llm_role == "identifier" and not (is_numeric and is_float))
            or (high_uniqueness_text and (llm_role == "identifier" or has_id_token or len(tokens) <= 2))
        ) and col_lower not in ("month_num", "monthnum", "quarter_num")

        # Respect LLM marking low-cardinality numeric codes/tiers as dimensions
        llm_prefers_dimension = llm_role == "dimension" and is_numeric and not is_float and series.nunique() <= 20

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
        elif is_numeric and not llm_prefers_dimension:
            col_type = "decimal" if is_float else "integer"
            role = "measure"
            rate_tokens = {"percent", "percentage", "pct", "ratio", "rate", "margin", "avg", "mean", "score", "rating"}
            is_rate = bool(token_set & rate_tokens) or ann.get("unit") == "%"
            llm_agg = str(ann.get("default_aggregation") or "").upper()
            if llm_agg in ("SUM", "AVG", "MIN", "MAX", "COUNT"):
                default_agg = llm_agg
            elif is_rate:
                default_agg = "AVG"
            else:
                default_agg = "SUM"

            if is_rate or default_agg == "AVG":
                aggregations = ["AVG", "MIN", "MAX", "COUNT"]
                if not is_rate:
                    aggregations = ["SUM", "AVG", "MIN", "MAX", "COUNT"]
            else:
                aggregations = ["SUM", "AVG", "MIN", "MAX", "COUNT"]
        else:
            col_type = "string"
            role = "dimension"
            aggregations = ["COUNT", "COUNT_DISTINCT"]
            default_agg = None

        # Display name & description
        raw_pretty = " ".join(t.title() for t in tokens) if tokens else col.replace("_", " ").title()
        display_name = str(ann.get("semantic_name") or raw_pretty).strip()
        description = str(ann.get("description") or f"{display_name} ({role})").strip()

        # Physical unit & currency
        unit = ann.get("unit") or ("%" if (token_set & {"percent", "percentage", "pct", "rate"}) else None)
        currency = ann.get("currency") or (
            "USD" if (token_set & {"usd", "price", "revenue", "cost", "salary", "amount", "sales", "profit"}) else None
        )

        # Dynamic Synonyms
        synonyms = set(str(s) for s in (ann.get("synonyms") or []) if s)
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
            evidence=f"Inferred from 5-row sample: {samples[:3]}",
        )

    def _fallback_domain_name(self, columns: List[str], dataset_name: Optional[str] = None) -> str:
        """Derive clean domain name from dataset name or column names if LLM is unavailable."""
        if dataset_name:
            cleaned = str(dataset_name).rsplit(".", 1)[0]
            cleaned = re.sub(r"[_\-]+", " ", cleaned).strip()
            if cleaned and cleaned.lower() not in ("dataset", "data", "file", "upload", "uploaded dataset", "sheet1"):
                return cleaned.title()
        tokens = []
        for col in columns[:3]:
            words = _split_identifier_tokens(col)
            for w in words:
                if w not in ("id", "key", "code", "date", "name", "num") and w not in tokens:
                    tokens.append(w)
                if len(tokens) >= 2:
                    break
            if len(tokens) >= 2:
                break
        return f"{' '.join(t.title() for t in tokens)} Analytics" if tokens else "Open-Domain Analytics"


domain_classifier_agent = DomainClassifierAgent()
