"""
Intent Engine — LLM-based Intent & Query Plan Extraction
==========================================================
Uses the NVIDIA NIM LLM to classify user prompts into structured query plans.
Falls back to keyword heuristics if LLM is unavailable.
"""

import json
import re
from typing import Dict, Any, Optional, List
from api.services.ai_core_service import ai_core_service
from api.services.schema_service import schema_service
from api.utils.logger import get_logger

logger = get_logger("services.intent_engine")


# ── Default query plan ────────────────────────────────────────────────────────

def _default_query_plan() -> Dict[str, Any]:
    return {
        "intent": "chat",
        "metric": None,
        "aggregation": None,
        "dimension": None,
        "filters": [],
        "date_filter": None,
        "sort": None,
        "limit": None,
        "chart_type": None,
        "requires_vector_search": True,
        "requires_structured_query": False,
    }


# ── System prompt for intent classification ───────────────────────────────────

_INTENT_SYSTEM_PROMPT = """You are a precise query classification engine for an enterprise sales analytics platform.

Given a user's natural language question, analyze it and return a JSON object representing the query plan.

DATASET SCHEMA:
{schema}

RULES:
1. "intent" must be one of: "chat", "graph", "analytical", "comparison", "ranking"
   - "analytical": aggregation questions (total, average, sum, count, max, min)
   - "graph": any request to create/show/plot a chart/graph/visualization
   - "ranking": top N, bottom N, highest, lowest, best, worst
   - "comparison": compare between time periods, regions, categories
   - "chat": semantic questions, explanations, business context, why questions
2. "metric" must be an exact column name from the schema if applicable (e.g. "NetRevenueUSD", "GrossMarginUSD")
3. "aggregation" must be one of: "SUM", "AVG", "COUNT", "MIN", "MAX", "COUNT_DISTINCT", null
4. "dimension" must be an exact column name (e.g. "Region", "CustomerName", "Category")
5. "filters" is an array of objects: {{"column": "<exact_col>", "operator": "=|!=|>|<|>=|<=|IN|CONTAINS", "value": "<value>"}}
6. "date_filter" is null or {{"column": "Year|Quarter|MonthName|OrderDate", "from": "<value>", "to": "<value>"}}
   - For year filters like "in 2025", use: {{"column": "Year", "from": "2025", "to": "2025"}}
7. "sort" is null or {{"column": "<col>", "direction": "ASC|DESC"}}
8. "limit" is null or a positive integer (for top/bottom N)
9. "chart_type" is null or one of: "bar", "line", "pie", "donut", "scatter", "area", "heatmap", "box", "violin", "funnel", "waterfall", "treemap", "stacked_bar", "horizontal_bar"
10. "requires_vector_search": true if the question needs semantic context from the knowledge base
11. "requires_structured_query": true if the question needs data calculation from the dataset

Map user terms directly to the actual matching column names from the provided DATASET SCHEMA based on business semantics, synonyms, and context.

Return ONLY valid JSON. No explanation, no markdown.

USER QUERY:
{query}

JSON RESPONSE:"""


class IntentEngine:
    """
    Classifies user prompts into structured query plans using LLM + schema awareness.
    """

    def classify(self, user_prompt: str) -> Dict[str, Any]:
        """
        Classify a user prompt into a structured query plan.
        Uses fast-path keyword heuristics first (<5ms, 0 tokens).
        Falls back to compact LLM classification only for ambiguous prompts.
        """
        from api.models.execution_context import current_selection
        if current_selection.get() is not None:
            from api.platform.planning import classify_request
            return classify_request(user_prompt)
        # 1. Fast-path heuristic classification (< 5ms, 0 tokens)
        heuristic_plan = self._classify_heuristic(user_prompt)
        heuristic_plan = self._validate_and_fix(heuristic_plan, user_prompt)

        # Check if heuristic captured an actionable, confident intent
        has_actionable_intent = heuristic_plan.get("intent") in ("analytical", "ranking", "comparison", "graph")
        has_target = bool(heuristic_plan.get("metric") or heuristic_plan.get("dimension") or heuristic_plan.get("chart_type"))

        if has_actionable_intent and has_target:
            logger.info(f"[IntentEngine] Fast-path heuristic match: intent={heuristic_plan['intent']}, "
                        f"metric={heuristic_plan.get('metric')}, dim={heuristic_plan.get('dimension')}, "
                        f"chart={heuristic_plan.get('chart_type')} (0 tokens)")
            return heuristic_plan

        # 2. LLM fallback only for ambiguous or semantic questions
        try:
            llm_plan = self._classify_with_llm(user_prompt)
            if llm_plan:
                plan = _default_query_plan()
                plan.update(llm_plan)
                plan = self._validate_and_fix(plan, user_prompt)
                logger.info(f"[IntentEngine] LLM fallback classification: intent={plan['intent']}, "
                            f"metric={plan.get('metric')}, dim={plan.get('dimension')}")
                return plan
        except Exception as e:
            logger.warning(f"[IntentEngine] LLM classification fallback failed: {e}")

        logger.info(f"[IntentEngine] Default heuristic classification: intent={heuristic_plan['intent']}")
        return heuristic_plan

    # ── LLM Classification ────────────────────────────────────────────────────

    def _classify_with_llm(self, prompt: str) -> Optional[Dict[str, Any]]:
        """Use NVIDIA NIM LLM with compact schema to classify ambiguous prompts."""
        schema_text = schema_service.get_compact_schema_for_prompt()
        system_prompt = _INTENT_SYSTEM_PROMPT.format(schema=schema_text, query=prompt)

        response = ai_core_service.generate_nvidia_completion(system_prompt)
        if not response or not response.strip():
            return None

        # Extract JSON from response
        return self._parse_json_response(response)

    def _parse_json_response(self, response: str) -> Optional[Dict[str, Any]]:
        """Extract and parse JSON from LLM response."""
        text = response.strip()

        # Try direct JSON parse
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

        # Try extracting JSON block from markdown
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

        logger.warning(f"[IntentEngine] Could not parse LLM response as JSON: {text[:200]}")
        return None

    # ── Heuristic Classification ──────────────────────────────────────────────

    def _classify_heuristic(self, prompt: str) -> Dict[str, Any]:
        """Keyword-based fallback classification."""
        plan = _default_query_plan()
        p = prompt.lower().strip()

        # 1. Detect intent
        plan["intent"] = self._detect_intent_keywords(p)

        # 2. Detect metric
        plan["metric"] = self._detect_metric(p)

        # 3. Detect dimension
        plan["dimension"] = self._detect_dimension(p)

        # 4. Detect chart type
        if plan["intent"] == "graph":
            plan["chart_type"] = self._detect_chart_type(p)

        # 5. Detect filters
        plan["filters"] = self._detect_filters(p)

        # 6. Detect date filter
        plan["date_filter"] = self._detect_date_filter(p)

        # 7. Detect limit / ranking
        limit = self._detect_limit(p)
        if limit:
            plan["limit"] = limit
            if plan["intent"] == "chat":
                plan["intent"] = "ranking"

        # 8. Detect sort direction
        if any(w in p for w in ["bottom", "lowest", "worst", "least", "minimum"]):
            plan["sort"] = {"column": plan["metric"] or "NetRevenueUSD", "direction": "ASC"}
        elif plan["intent"] in ("ranking",) or plan.get("limit"):
            plan["sort"] = {"column": plan["metric"] or "NetRevenueUSD", "direction": "DESC"}

        # 9. Set requires_* flags
        if plan["intent"] in ("analytical", "ranking", "comparison"):
            plan["requires_structured_query"] = True
            plan["requires_vector_search"] = False
        elif plan["intent"] == "graph":
            plan["requires_structured_query"] = True
            plan["requires_vector_search"] = False
        else:
            # Chat: check if it's a numerical question
            numerical_words = ["total", "sum", "average", "count", "how many", "how much",
                             "maximum", "minimum", "highest", "lowest"]
            if any(w in p for w in numerical_words) and plan["metric"]:
                plan["requires_structured_query"] = True
                plan["requires_vector_search"] = True
            else:
                plan["requires_structured_query"] = False
                plan["requires_vector_search"] = True

        # Set default aggregation
        if plan["metric"] and not plan["aggregation"]:
            meta = schema_service.get_metadata()
            if plan["metric"] in meta:
                plan["aggregation"] = meta[plan["metric"]].default_aggregation

        return plan

    def _detect_intent_keywords(self, p: str) -> str:
        """Detect intent from keywords."""
        graph_keywords = [
            "chart", "graph", "plot", "visualize", "visualization",
            "bar chart", "line chart", "scatter", "box plot", "pie chart",
            "histogram", "show graph", "draw graph", "show chart",
            "create a chart", "create a graph", "generate a graph",
            "generate a chart", "make a chart", "make a graph",
            "trendline", "dual-axis", "trend line", "waterfall", "donut",
            "treemap", "funnel", "heatmap", "heat map", "trend"
        ]
        if any(kw in p for kw in graph_keywords):
            return "graph"

        ranking_keywords = ["top", "bottom", "highest", "lowest", "best", "worst",
                          "most", "least", "rank", "ranking"]
        if any(kw in p for kw in ranking_keywords):
            return "ranking"

        comparison_keywords = ["compare", "comparison", "vs", "versus", "difference between",
                             "better", "worse"]
        if any(kw in p for kw in comparison_keywords):
            return "comparison"

        analytical_keywords = ["total", "sum", "average", "avg", "count", "how many",
                             "how much", "calculate", "what is the", "what was the",
                             "maximum", "minimum", "aggregate"]
        if any(kw in p for kw in analytical_keywords):
            return "analytical"

        return "chat"

    def _get_active_semantic_model(self):
        try:
            from api.models.execution_context import current_selection
            sel = current_selection.get()
            if sel and sel.entry:
                from api.platform.semantic import semantic_registry
                return semantic_registry.get(sel.entry, sel.context.version, sel.context.semantic_revision, approved=False)
        except Exception:
            pass
        return None

    def _detect_metric(self, p: str, model: Optional[Any] = None, df: Optional[Any] = None) -> Optional[str]:
        """Detect the metric/measure dynamically from semantic model or active DataFrame."""
        active_model = model or self._get_active_semantic_model()
        if active_model and active_model.fields:
            for f in [f for f in active_model.fields if f.role == "measure"]:
                candidates = [f.name.lower(), f.semantic_name.lower()] + [a.lower() for a in (f.aliases or [])]
                for c in candidates:
                    if re.search(r'\b' + re.escape(c) + r'\b', p):
                        return f.name
            if any(k in p for k in ["total", "sum", "average", "avg", "trend", "overall"]):
                measures = [f.name for f in active_model.fields if f.role == "measure"]
                if measures:
                    return measures[0]

        target_df = df
        if target_df is None:
            try:
                from api.services.data_service import data_service
                target_df = data_service.get_dataframe()
            except Exception:
                pass

        if target_df is not None and not target_df.empty:
            nums = [c for c in target_df.select_dtypes(include=['number']).columns if not str(c).lower().endswith(('id', 'code', 'key'))]
            for col in nums:
                clean_col = str(col).lower()
                clean_no_usd = clean_col.replace('usd', '').replace('eur', '').replace('inr', '')
                if clean_col in p or clean_no_usd in p or clean_col.replace('_', ' ') in p:
                    return col
            if nums and any(k in p for k in ["total", "sum", "average", "avg", "how much", "cost", "salary", "revenue", "price", "rate"]):
                return nums[0]

        return None

    def _detect_dimension(self, p: str, model: Optional[Any] = None, df: Optional[Any] = None) -> Optional[str]:
        """Detect the dimension/grouping dynamically from semantic model or active DataFrame."""
        years = re.findall(r'\b(20[12]\d)\b', p)
        multi_year = len(set(years)) > 1
        quarterly_words = ["quarterly", "quarter", "by quarter", "per quarter", "each quarter"]
        monthly_words = ["monthly", "month", "by month", "per month", "each month"]
        separately_words = ["separately", "each", "broken down", "split", "break down"]

        if multi_year:
            has_quarterly = any(w in p for w in quarterly_words)
            has_monthly = any(w in p for w in monthly_words)
            has_separately = any(w in p for w in separately_words)
            if has_quarterly or (has_separately and "quarter" in p):
                return "Year, Quarter"
            if has_monthly or (has_separately and "month" in p):
                return "Year, MonthName"

        active_model = model or self._get_active_semantic_model()
        if active_model and active_model.fields:
            for f in [f for f in active_model.fields if f.role in ("dimension", "time")]:
                candidates = [f.name.lower(), f.semantic_name.lower()] + [a.lower() for a in (f.aliases or [])]
                for c in candidates:
                    if re.search(r'\b' + re.escape(c) + r'\b', p):
                        return f.name

        target_df = df
        if target_df is None:
            try:
                from api.services.data_service import data_service
                target_df = data_service.get_dataframe()
            except Exception:
                pass

        if target_df is not None and not target_df.empty:
            cats = [c for c in target_df.columns if not str(c).lower().endswith(('id', 'code', 'key'))]
            for col in cats:
                clean_col = str(col).lower()
                if clean_col in p or clean_col.replace('_', ' ') in p or clean_col.replace(' ', '') in p:
                    return col
            m_by = re.search(r'\b(?:by|per|across|for each|split by|group by)\s+([a-zA-Z0-9_]+)', p)
            if m_by:
                target_word = m_by.group(1).lower()
                for col in target_df.columns:
                    if target_word in str(col).lower():
                        return col

        dim_terms = [
            ("by customer", "CustomerName"), ("by product", "ProductName"),
            ("by region", "Region"), ("by country", "Country"),
            ("by category", "Category"), ("by subcategory", "Subcategory"),
            ("by segment", "CustomerSegment"), ("by channel", "Channel"),
            ("by industry", "IndustryVertical"), ("by quarter", "Quarter"),
            ("by month", "MonthName"), ("by year", "Year"),
            ("by sales rep", "SalesRepName"), ("by rep", "SalesRepName"),
        ]
        for term, col in dim_terms:
            if term in p:
                return col
        return None

    def _detect_chart_type(self, p: str) -> Optional[str]:
        """Detect explicit chart type from prompt."""
        chart_map = {
            "pie chart": "pie", "donut": "donut", "doughnut": "donut",
            "line chart": "line", "line graph": "line", "trendline": "line", "dual-axis": "line", "trend line": "line",
            "bar chart": "bar", "bar graph": "bar",
            "scatter": "scatter", "scatter plot": "scatter",
            "heatmap": "heatmap", "heat map": "heatmap",
            "area chart": "area", "area graph": "area",
            "box plot": "box", "boxplot": "box",
            "violin": "violin",
            "funnel": "funnel", "waterfall": "waterfall",
            "treemap": "treemap", "tree map": "treemap",
            "stacked": "stacked_bar", "horizontal bar": "horizontal_bar",
        }
        for kw, ct in chart_map.items():
            if kw in p:
                return ct

        # Heuristics
        if any(w in p for w in ["monthly", "weekly", "daily", "yearly", "over time", "trend"]):
            return "line"
        if any(w in p for w in ["share", "proportion", "breakdown", "distribution"]):
            return "pie"
        if any(w in p for w in ["compare", "comparison", "vs", "versus", "across"]):
            return "bar"

        return "bar"  # default

    def _detect_filters(self, p: str) -> List[Dict[str, Any]]:
        """Extract filter conditions from the prompt."""
        filters = []
        meta = schema_service.get_metadata()

        # Country filter patterns
        for col_meta in meta.values():
            if col_meta.is_dimension and col_meta.sample_values:
                for val in col_meta.sample_values:
                    val_str = str(val).lower()
                    if len(val_str) > 2 and val_str in p:
                        filters.append({
                            "column": col_meta.column_name,
                            "operator": "=",
                            "value": str(val)
                        })

        # Numeric comparison patterns: "revenue greater than 50000"
        numeric_pattern = r'(?:greater than|more than|above|over|exceeds?)\s+(\d+(?:,\d{3})*(?:\.\d+)?)'
        match = re.search(numeric_pattern, p)
        if match:
            value = float(match.group(1).replace(",", ""))
            metric = self._detect_metric(p)
            if metric:
                filters.append({"column": metric, "operator": ">", "value": value})

        lt_pattern = r'(?:less than|under|below|fewer than)\s+(\d+(?:,\d{3})*(?:\.\d+)?)'
        match = re.search(lt_pattern, p)
        if match:
            value = float(match.group(1).replace(",", ""))
            metric = self._detect_metric(p)
            if metric:
                filters.append({"column": metric, "operator": "<", "value": value})

        return filters

    def _detect_date_filter(self, p: str) -> Optional[Dict[str, Any]]:
        """Extract date/year filter from the prompt."""
        # Year pattern: capture ALL years mentioned (e.g. "2023, 2024, and 2025")
        year_matches = re.findall(r'\b(20[12]\d)\b', p)
        if year_matches:
            unique_years = sorted(set(year_matches))
            from_year = unique_years[0]
            to_year = unique_years[-1]
            return {"column": "Year", "from": from_year, "to": to_year}

        # Quarter pattern: "Q1 2025", "Q3"
        q_match = re.search(r'\bQ([1-4])\b', p, re.IGNORECASE)
        if q_match:
            quarter = f"Q{q_match.group(1)}"
            return {"column": "Quarter", "from": quarter, "to": quarter}

        return None

    def _detect_limit(self, p: str) -> Optional[int]:
        """Detect top/bottom N from the prompt."""
        # "top 10", "bottom 5", "first 20"
        match = re.search(r'\b(?:top|bottom|first|last|best|worst)\s+(\d+)\b', p, re.IGNORECASE)
        if match:
            return int(match.group(1))
        # "10 customers", "5 products" at start
        match = re.search(r'^(?:show\s+)?(\d+)\s+(?:top\s+)?', p)
        if match:
            n = int(match.group(1))
            if 1 < n <= 100:
                return n
        return None

    # ── Validation ────────────────────────────────────────────────────────────

    def _validate_and_fix(self, plan: Dict[str, Any], prompt: str) -> Dict[str, Any]:
        """Validate the query plan against the actual schema and fix issues."""
        meta = schema_service.get_metadata()

        # Validate metric column exists
        if plan.get("metric") and plan["metric"] not in meta:
            resolved = schema_service.resolve_column(plan["metric"])
            if resolved:
                plan["metric"] = resolved
            else:
                logger.warning(f"[IntentEngine] Metric '{plan['metric']}' not found in schema")
                plan["metric"] = None

        # Validate dimension column exists (support composite dimensions like "Year, Quarter")
        if plan.get("dimension"):
            dim = plan["dimension"]
            if ", " in dim:
                # Composite dimension — validate each part
                parts = [d.strip() for d in dim.split(",")]
                valid_parts = []
                for part in parts:
                    if part in meta:
                        valid_parts.append(part)
                    else:
                        resolved = schema_service.resolve_column(part)
                        if resolved:
                            valid_parts.append(resolved)
                        else:
                            logger.warning(f"[IntentEngine] Composite dimension part '{part}' not found")
                if valid_parts:
                    plan["dimension"] = ", ".join(valid_parts)
                else:
                    plan["dimension"] = None
            elif dim not in meta:
                resolved = schema_service.resolve_column(dim)
                if resolved:
                    plan["dimension"] = resolved
                else:
                    logger.warning(f"[IntentEngine] Dimension '{dim}' not found in schema")
                    plan["dimension"] = None

        # Merge duplicate equality filters on the same column into IN filter
        # e.g. Year=2023 AND Year=2024 AND Year=2025 → Year IN [2023,2024,2025]
        raw_filters = plan.get("filters", [])
        if raw_filters:
            from collections import defaultdict
            eq_groups = defaultdict(list)  # column → [values]
            non_eq_filters = []
            for f in raw_filters:
                if f.get("operator") == "=" and f.get("column") and f.get("value") is not None:
                    eq_groups[f["column"]].append(f["value"])
                else:
                    non_eq_filters.append(f)

            merged_filters = list(non_eq_filters)
            for col, values in eq_groups.items():
                if len(values) > 1:
                    merged_filters.append({"column": col, "operator": "IN", "value": values})
                    logger.info(f"[IntentEngine] Merged {len(values)} equality filters on '{col}' into IN filter")
                else:
                    merged_filters.append({"column": col, "operator": "=", "value": values[0]})
            raw_filters = merged_filters

        # Validate filters
        valid_filters = []
        for f in raw_filters:
            col = f.get("column")
            if col and col not in meta:
                resolved = schema_service.resolve_column(col)
                if resolved:
                    f["column"] = resolved
                else:
                    continue
            valid_filters.append(f)
        plan["filters"] = valid_filters

        # If we have an IN filter for Year that covers the same range as date_filter,
        # prefer the date_filter (range) and remove the redundant IN filter
        date_filter = plan.get("date_filter")
        if date_filter and date_filter.get("column") == "Year":
            plan["filters"] = [
                f for f in plan["filters"]
                if not (f.get("column") == "Year" and f.get("operator") in ("=", "IN"))
            ]

        # Detect composite dimension from multi-year prompts (LLM path)
        if plan.get("dimension") and ", " not in str(plan.get("dimension", "")):
            p = prompt.lower()
            years = re.findall(r'\b(20[12]\d)\b', p)
            multi_year = len(set(years)) > 1
            quarterly_words = ["quarterly", "quarter", "by quarter", "per quarter", "each quarter"]
            monthly_words = ["monthly", "month", "by month", "per month", "each month"]
            separately_words = ["separately", "each", "broken down", "split", "break down"]

            if multi_year:
                dim = plan["dimension"]
                has_quarterly = any(w in p for w in quarterly_words) or dim == "Quarter"
                has_monthly = any(w in p for w in monthly_words) or dim == "MonthName"
                has_separately = any(w in p for w in separately_words)

                if has_quarterly or (has_separately and "quarter" in p):
                    plan["dimension"] = "Year, Quarter"
                elif has_monthly or (has_separately and "month" in p):
                    plan["dimension"] = "Year, MonthName"

        # Validate aggregation
        valid_aggs = {"SUM", "AVG", "COUNT", "MIN", "MAX", "COUNT_DISTINCT"}
        if plan.get("aggregation") and plan["aggregation"] not in valid_aggs:
            plan["aggregation"] = "SUM"

        # Validate chart type
        valid_charts = {"bar", "line", "pie", "donut", "scatter", "area", "heatmap",
                       "box", "violin", "funnel", "waterfall", "treemap", "stacked_bar",
                       "horizontal_bar"}
        if plan.get("chart_type") and plan["chart_type"] not in valid_charts:
            plan["chart_type"] = "bar"

        # Validate intent
        valid_intents = {"chat", "graph", "analytical", "comparison", "ranking"}
        if plan.get("intent") not in valid_intents:
            plan["intent"] = "chat"

        # Set defaults for analytical/ranking/graph if metric is missing
        if plan["intent"] in ("analytical", "ranking", "graph") and not plan.get("metric"):
            plan["metric"] = "NetRevenueUSD"
            plan["aggregation"] = "SUM"

        return plan


intent_engine = IntentEngine()
