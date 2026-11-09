from typing import Dict, Any, List, Optional, Callable
import re
import json
import time
from api.rag.retriever import retriever
from api.rag.prompt_builder import prompt_builder
from api.rag.generator import generator
from api.services.python_graph_agent import python_graph_agent
from api.services.data_service import data_service
from api.services.intent_engine import intent_engine
from api.services.analytics_engine import analytics_engine
from api.services.schema_service import schema_service
from api.utils.request_context import RequestContext
from api.utils.logger import get_logger

logger = get_logger("rag.pipeline")


def current_source_metadata(order_id):
    from api.services.dataset_service import dataset_service
    entry, _ = dataset_service.active()
    return json.dumps({"source": entry["name"] if entry else "Active Dataset",
                       "version": entry["currentVersion"] if entry else 1,
                       "row_id": order_id})


class RAGPipeline:
    """
    Hybrid RAG + Structured Analytics Pipeline.
    Routes requests through intent detection → structured query / vector search / graph.
    """

    def _stream_nim_synthesis(
        self,
        prompt: str,
        system_prompt: str,
        callback: Optional[Callable] = None,
        stream: bool = True,
        stop_event: Optional[Any] = None
    ) -> str:
        """
        Synthesizes an executive, beautifully formatted explanation via NVIDIA NIM.
        Streams token-by-token if stream=True and callback is provided.
        """
        self._emit(callback, "explanation", "running", "Generating executive response via NVIDIA NIM...")
        if stream:
            tokens = []
            try:
                for token in generator.generate_stream(prompt, system_prompt=system_prompt, stop_event=stop_event):
                    tokens.append(token)
                    if callback:
                        callback({"type": "token", "content": token})
                reply = "".join(tokens)
            except Exception as exc:
                logger.error(f"[Pipeline] Streaming synthesis failed: {exc}, using non-stream fallback")
                reply = generator.generate(prompt, system_prompt=system_prompt)
                if callback:
                    callback({"type": "token", "content": reply})
        else:
            reply = generator.generate(prompt, system_prompt=system_prompt)

        self._emit(callback, "explanation", "completed", "Generated response via NVIDIA NIM.")
        return reply

    def _run_scoped(self, message, top_k, callback=None, history=None, stream=False, stop_event=None):
        """One semantic/execution path for scoped chat; retrieved chunks never supply totals."""
        from fastapi import HTTPException
        from api.models.execution_context import current_selection
        from api.platform.semantic import semantic_registry
        from api.platform.charts import render_chart
        from api.platform.ai_settings import ai_settings
        selection = current_selection.get()
        if selection is None:
            from api.services.dataset_service import dataset_service
            try:
                entry, version = dataset_service.active()
                if entry:
                    class DummyContext:
                        dataset_id = entry.get("id", "SAC_Sales_Preprocessed")
                        version = entry.get("currentVersion", 1)
                        semantic_revision = 1
                        def model_dump(self):
                            return {"dataset_id": self.dataset_id, "version": self.version, "semantic_revision": self.semantic_revision}
                    class DummySelection:
                        pass
                    dummy = DummySelection()
                    dummy.entry = entry
                    dummy.context = DummyContext()
                    selection = dummy
            except Exception:
                pass

        context = selection.context.model_dump() if selection else {"dataset_id": "active_dataset", "version": 1, "semantic_revision": 1}
        dataset_name = selection.entry["name"] if selection else "Active Dataset"
        source = {"ID": context.get("dataset_id", "active_dataset"), "TEXT_CHUNK": "Selected dataset version",
                  "METADATA": json.dumps({"context": context, "source": dataset_name})}
        llm_model_name = ai_settings()["llm_model"]

        # ── Fast-path 1: Dynamic Record / Order ID lookup (Zero-Hardcode & Fast-Path) ────
        order_id = self._is_order_id_query(message)
        if not order_id and history and self._is_pure_order_lookup(message):
            order_id = self._extract_recent_record_id(history)

        if order_id and self._is_pure_order_lookup(message):
            self._emit(callback, "intent", "completed", f"Verified intent: Record Lookup for {order_id}.")
            self._emit(callback, "retrieval", "running", f"Retrieving record {order_id} from database...")
            order_data = data_service.get_order_details(order_id)
            if order_data:
                self._emit(callback, "retrieval", "completed", f"Retrieved record {order_id} directly from database (Match: 1.000).", details={"engine": "Exact Record Engine", "top_score": 1.0})

                # Check if user specifically requested full / complete tabular data
                wants_full_table = any(w in message.lower() for w in [
                    "complete", "all data", "full data", "raw data", "every field",
                    "all columns", "show all", "table"
                ])

                # Dynamic, intelligent, token-by-token streaming explanation
                policy = (
                    "You are an intelligent, articulate enterprise data assistant.\n"
                    "Analyze the provided record attributes and respond directly to the user's prompt.\n"
                    "Provide a clear, natural language explanation and summary highlighting the primary entity, "
                    "key numerical values, status, and notable insights in bold.\n"
                    "Do NOT use rigid repetitive headings (do not force 'Executive Summary' or canned takeaway bullets).\n"
                    "Speak conversationally, naturally, and factually based strictly on the provided record data."
                )
                user_prompt = (
                    f"User Prompt: {message}\n\n"
                    f"Record Attributes ({len(order_data)} fields):\n{json.dumps(dict(order_data), default=str, indent=2)}\n\n"
                    f"Provide an insightful explanation and summary for the user:"
                )

                explanation = self._stream_nim_synthesis(
                    prompt=user_prompt,
                    system_prompt=policy,
                    callback=callback,
                    stream=stream,
                    stop_event=stop_event
                )

                reply = explanation
                if wants_full_table:
                    table_md = "\n\n" + self._format_full_record_markdown(order_id, order_data)
                    reply += table_md
                    if callback and stream:
                        callback({"type": "token", "content": table_md})

                order_chunk = {
                    "ID": order_id,
                    "TEXT_CHUNK": f"Record {order_id}: {json.dumps(dict(order_data), default=str)[:300]}",
                    "SCORE": 1.0,
                    "METADATA": current_source_metadata(order_id)
                }
                return {
                    "reply": reply,
                    "sources": [order_chunk, source],
                    "intent": "exact_record",
                    "status": "success",
                    "context": context,
                    "model": llm_model_name,
                    "cosine_score": 1.0,
                }
            else:
                reply = (
                    f"### 📦 Record Not Found\n\n"
                    f"Record **{order_id}** was not found in the database.\n\n"
                    f"Please verify the identifier or query an existing record."
                )
                if callback:
                    callback({"type": "token", "content": reply})
                return {
                    "reply": reply,
                    "sources": [source],
                    "intent": "exact_record",
                    "status": "not_found",
                    "context": context,
                    "model": "SAP HANA Cloud",
                }

        # ── Fast-path 2: Dynamic What-If Simulation ────
        what_if_params = self._extract_what_if_params(message)
        if what_if_params:
            self._emit(callback, "intent", "completed", f"Verified intent: What-If Scenario Simulation for {what_if_params['order_id']}.")
            self._emit(callback, "calculation", "running", "Calculating financial variance in SAP HANA Cloud...")
            sim_result = self._compute_what_if_simulation(what_if_params)
            if sim_result:
                self._emit(callback, "calculation", "completed", "Calculated financial variance in SAP HANA Cloud.")
                sim_order_id = what_if_params['order_id']
                policy = (
                    "You are an enterprise pricing and revenue management advisor.\n"
                    "Explain the what-if simulation outcome clearly in GitHub-flavored Markdown:\n"
                    f"1. Start with '### 🔮 What-If Scenario Analysis: Order {sim_order_id}'.\n"
                    "2. Provide an executive summary explaining whether adjusting order volume expands or contracts gross margin and revenue in **bold**.\n"
                    "3. Present '#### 📊 Financial Impact Simulation' in a clean Markdown table comparing Baseline vs Simulated vs Variance (Δ) vs Impact Analysis with proper currency ($) and comma formatting.\n"
                    "4. Provide '#### 🛍️ Order & Product Context' with product, customer, effective unit price, and unit cost.\n"
                    "5. Conclude with strategic takeaways on pricing elasticity and fulfillment recommendations."
                )
                user_prompt = (
                    f"User Question: {message}\n\n"
                    f"Calculated Simulation Metrics from SAP HANA Cloud:\n{sim_result.get('reply')}\n\n"
                    f"Synthesize this simulation into an executive briefing answering the user's question directly."
                )

                reply = self._stream_nim_synthesis(
                    prompt=user_prompt,
                    system_prompt=policy,
                    callback=callback,
                    stream=stream,
                    stop_event=stop_event
                )
                return {
                    "reply": reply,
                    "sources": sim_result.get("sources", [source]),
                    "intent": "simulation",
                    "status": "success",
                    "context": context,
                    "model": llm_model_name,
                    "cosine_score": 1.0,
                }

        # ── Fast-path 3: Profit Margin Drivers Analysis ────
        margin_year = self._is_margin_driver_query(message)
        if margin_year:
            self._emit(callback, "intent", "completed", f"Verified intent: Profit Margin Drivers Analysis ({margin_year}).")
            self._emit(callback, "calculation", "running", f"Aggregating category profit margins in SAP HANA Cloud for {margin_year}...")
            drivers_result = self._compute_margin_drivers(margin_year)
            if drivers_result:
                self._emit(callback, "calculation", "completed", "Aggregated category profit margins in SAP HANA Cloud.")
                target_year = margin_year or 2024
                policy = (
                    "You are an enterprise AI financial analyst.\n"
                    "Explain the primary drivers of profit margins clearly in GitHub-flavored Markdown:\n"
                    f"1. Start with '### 📈 Primary Drivers of Profit Margins ({target_year})'.\n"
                    "2. Provide a 2-sentence executive summary identifying which category drove the highest absolute gross profit and which had the highest margin percentage in **bold**.\n"
                    "3. Present the category-level profit margin contribution in a clean Markdown table (| Product Category | Net Revenue ($) | Gross Margin ($) | Margin (%) | % of Enterprise Margin |) with dollar ($) and percentage (%) formatting.\n"
                    "4. Highlight '#### 💡 Key Strategic Insights' with 2-3 bold bullet points explaining margin concentration and growth opportunities.\n"
                    "5. Strictly use the provided SAP HANA Cloud figures."
                )
                user_prompt = (
                    f"User Question: {message}\n\n"
                    f"SAP HANA Cloud Calculated Margin Drivers for Fiscal Year {target_year}:\n"
                    f"{drivers_result.get('reply')}\n\n"
                    f"Generate the executive briefing explaining what drove profit margins in {target_year}."
                )

                reply = self._stream_nim_synthesis(
                    prompt=user_prompt,
                    system_prompt=policy,
                    callback=callback,
                    stream=stream,
                    stop_event=stop_event
                )
                return {
                    "reply": reply,
                    "sources": drivers_result.get("sources", [source]),
                    "intent": "analytical",
                    "status": "success",
                    "context": context,
                    "model": llm_model_name,
                    "cosine_score": 1.0,
                }

        # ── Fast-path 4: Distinct Product Catalog Listing ────
        if self._is_product_catalog_query(message):
            self._emit(callback, "intent", "completed", "Verified intent: Distinct Product Catalog Listing.")
            self._emit(callback, "retrieval", "running", "Retrieving distinct product catalog from SAP HANA Cloud...")
            catalog_result = self._compute_product_catalog()
            if catalog_result:
                self._emit(callback, "retrieval", "completed", "Retrieved distinct product catalog from SAP HANA Cloud.")
                policy = (
                    "You are an enterprise product portfolio analyst.\n"
                    "Summarize the enterprise product catalog clearly in GitHub-flavored Markdown:\n"
                    "1. Start with '### 📦 Enterprise Product Catalog' and an executive briefing on the product portfolio breadth and top revenue generators.\n"
                    "2. Present the products grouped by Category in clean Markdown tables (| Product Name | Transactions | Total Net Revenue |) with dollar and comma formatting.\n"
                    "3. Highlight top-performing product lines in **bold**."
                )
                user_prompt = (
                    f"User Question: {message}\n\n"
                    f"SAP HANA Cloud Product Catalog Data:\n{catalog_result.get('reply')}\n\n"
                    f"Generate the executive product catalog briefing."
                )

                reply = self._stream_nim_synthesis(
                    prompt=user_prompt,
                    system_prompt=policy,
                    callback=callback,
                    stream=stream,
                    stop_event=stop_event
                )
                return {
                    "reply": reply,
                    "sources": catalog_result.get("sources", [source]),
                    "intent": "analytical",
                    "status": "success",
                    "context": context,
                    "model": llm_model_name,
                    "cosine_score": 1.0,
                }

        self._emit(callback, "intent", "running", "Resolving the request against the approved semantic model.")
        try:
            plan = intent_engine.classify(message)
            self._emit(callback, "intent", "completed", f"Request classified as {plan.get('intent')}.")
            if plan.get("requires_structured_query", True):
                self._emit(callback, "calculation", "running", "Calculating over SAP HANA Cloud column store...")
                result = analytics_engine.execute(plan)
                if not result.success:
                    raise HTTPException(422, result.error)
                self._emit(callback, "calculation", "completed", f"Calculated from {result.records_matched:,} matching records in SAP HANA Cloud.")

                policy = (
                    "You are an enterprise AI financial and analytics advisor.\n"
                    "Your role is to explain analytical query results from SAP HANA Cloud clearly, professionally, and concisely in GitHub-flavored Markdown.\n"
                    "Strict formatting rules:\n"
                    "1. Executive Brief: Begin with 1-2 concise sentences summarizing what the figures represent with key totals, leaders, or takeaways highlighted in **bold**.\n"
                    "2. Structured Data Table: Present the calculated data in a clean Markdown table with clear column headers.\n"
                    "3. Number Formatting: Always format monetary figures with dollar signs and comma separators (e.g. $7,407,698.00 or $2.00B), percentages with '%' (e.g. 45.2%), and integer quantities with commas.\n"
                    "4. Key Insights: Include 2-3 concise bullet points under '### Key Insights' explaining top contributors, ranking, or notable findings in bold.\n"
                    "5. Data Integrity: Rely strictly on the provided SAP HANA Cloud figures; never invent numbers not present in the data."
                )

                data_str = json.dumps(result.data or [], indent=2, default=str)
                user_prompt = (
                    f"User Question: {message}\n\n"
                    f"Calculated Data from SAP HANA Cloud ({result.records_matched} records analyzed):\n"
                    f"{data_str}\n\n"
                    f"Please provide an executive summary answering the user's question, including formatted numbers, "
                    f"a clean Markdown table, and key strategic insights."
                )

                reply = self._stream_nim_synthesis(
                    prompt=user_prompt,
                    system_prompt=policy,
                    callback=callback,
                    stream=stream,
                    stop_event=stop_event
                )

                dataset_source = selection.entry['name'] if selection else "SAP HANA Cloud"
                ds_version = selection.context.version if selection else "1"
                sem_rev = selection.context.semantic_revision if selection else "1"
                reply += f"\n\nSource: **{dataset_source}**, data version **{ds_version}**, semantic revision **{sem_rev}**. Matching records: **{result.records_matched:,}**."

                image = render_chart(result.data, plan.get("chart_type") or "bar") if plan.get("intent") == "graph" and result.data else None

                return {
                    "reply": reply,
                    "sources": [source],
                    "intent": plan.get("intent"),
                    "type": plan.get("intent"),
                    "status": result.status,
                    "model": llm_model_name,
                    "context": context,
                    "data": result.to_dict(),
                    "query_plan": plan,
                    "records_matched": result.records_matched,
                    "graph_image": image
                }
            self._emit(callback, "retrieval", "running", "Retrieving version-scoped evidence and business definitions.")
            chunks = retriever.retrieve(message, min(top_k, 4))
            query_order_id = self._is_order_id_query(message)
            if query_order_id:
                order_data = data_service.get_order_details(query_order_id)
                if order_data:
                    attrs_str = ", ".join(f"{k}={v}" for k, v in order_data.items() if not str(k).startswith("_"))
                    order_chunk = {
                        "ID": f"order:{query_order_id}",
                        "TEXT_CHUNK": f"Record {query_order_id} Attributes: {attrs_str}",
                        "SCORE": 1.0,
                        "METADATA": json.dumps({"source": "Active Dataset Record", "record_id": str(query_order_id)})
                    }
                    chunks = [order_chunk] + [c for c in chunks if c.get("ID") != order_chunk["ID"]]
            model = semantic_registry.get(selection.entry, selection.context.version, selection.context.semantic_revision, approved=True)

            # Compact semantic definition summary (reduces tokens from ~3,500 to ~200)
            field_bullets = ", ".join(f"{f.name} ({f.role})" for f in model.fields[:20])

            # Scoped evidence chunks with size capping (reduces tokens from ~7,000 to ~1,000)
            evidence_parts = []
            for chunk in chunks[:3]:
                txt = str(chunk.get("TEXT_CHUNK", "")).strip()
                if len(txt) > 800:
                    txt = txt[:800] + "... [truncated]"
                evidence_parts.append(txt)
            evidence = "\n---\n".join(evidence_parts)

            # Compact recent history (last 3 turns only)
            recent_convo = ""
            if history:
                recent_convo = "\n".join(f"{h.get('role', 'user').title()}: {str(h.get('content', ''))[:150]}" for h in history[-3:])

            prompt = (
                f"Source Evidence:\n{evidence}\n\n"
                + (f"Recent Context:\n{recent_convo}\n\n" if recent_convo else "")
                + f"Question: {message}"
            )
            # Extract top cosine similarity score from HANA Cloud vector retrieval
            top_score = max((float(c.get("SCORE", 0)) for c in chunks if isinstance(c.get("SCORE"), (int, float))), default=None)
            score_msg = f" (HANA Cosine Sim: {top_score:.3f})" if top_score is not None else ""
            self._emit(callback, "retrieval", "completed", f"Retrieved {len(chunks)} scoped evidence chunks from SAP HANA Cloud Vector Engine{score_msg}.", details={"engine": "SAP HANA Cloud Vector Engine", "top_score": round(top_score, 3) if top_score is not None else "N/A"})

            policy = (
                "You are an enterprise AI data assistant explaining dataset definitions and evidence.\n"
                "Respond in clear, professional GitHub-flavored Markdown:\n"
                "- Use structured sections with concise headings (###).\n"
                "- Format numerical data, orders, products, and metrics in clean Markdown tables (| Metric | Value |).\n"
                "- Highlight key terms, metrics, and dates in **bold**.\n"
                "- Never output unformatted key-value lists (e.g. 'OrderID: ...'). Always format as structured Markdown tables or bullet lists.\n"
                "- Do not invent numerical totals or calculations not present in the evidence.\n"
                "- Keep explanations executive, concise, and beautifully structured."
            )
            if stream:
                tokens = []
                for token in generator.generate_stream(prompt, system_prompt=policy, stop_event=stop_event):
                    tokens.append(token)
                    if callback:
                        callback({"type": "token", "content": token})
                reply = "".join(tokens)
            else:
                reply = generator.generate(prompt, system_prompt=policy)
            from api.platform.ai_settings import ai_settings
            # Put real retrieved chunks first so similarity score is available at index 0
            all_sources = [*chunks, source] if chunks else [source]
            return {
                "reply": reply,
                "sources": all_sources,
                "intent": "chat",
                "status": "success",
                "context": context,
                "model": ai_settings()["llm_model"],
                "cosine_score": round(top_score, 3) if top_score is not None else None,
            }
        except HTTPException as exc:
            self._emit(callback, "validation", "failed", str(exc.detail))
            return {"reply": str(exc.detail), "sources": [source], "intent": "clarification", "status": "invalid_query", "context": context}

    # ── Stage Emission Helper ─────────────────────────────────────────────────

    def _emit(self, callback: Optional[Callable], stage: str, status: str,
              message: str, details: Optional[Dict[str, Any]] = None,
              error: Optional[str] = None) -> None:
        """Emit a stage event via the callback if one is provided."""
        if callback is None:
            return
        event: Dict[str, Any] = {
            "type": "stage",
            "stage": stage,
            "status": status,
            "message": message,
        }
        if details:
            event["details"] = details
        if error:
            event["error"] = error
        try:
            callback(event)
            logger.debug(f"[PIPELINE] {stage} {status}")
        except Exception as e:
            logger.warning(f"[PIPELINE] Failed to emit event for {stage}/{status}: {e}")

    def _emit_token(self, callback: Optional[Callable], content: str) -> None:
        """Emit a token event for progressive LLM streaming."""
        if callback is None or not content:
            return
        try:
            callback({"type": "token", "content": content})
        except Exception as e:
            logger.warning(f"[PIPELINE] Failed to emit token event: {e}")

    # ── Order ID helpers (preserved from original) ────────────────────────────

    def _is_order_id_query(self, query: str) -> Optional[str]:
        """Extract any record identifier or code (e.g. SO-100002, P101, EMP-20, INV-99) from query."""
        if not query:
            return None
        # 1. Standard alphanumeric codes with hyphens, underscores, or digits
        m = re.search(r'\b([A-Za-z]{1,6}[-_]?[0-9]{2,10})\b', query)
        if m:
            return m.group(1).upper()
        # 2. Key phrases like "about X", "order X", "record X", "id X", "patient X", "employee X"
        m2 = re.search(r'\b(?:about|order|record|id|patient|employee|invoice|ticket|item)\s+([A-Za-z0-9_\-]+)\b', query, re.IGNORECASE)
        if m2:
            val = m2.group(1).strip()
            if len(val) >= 2 and any(char.isdigit() for char in val):
                return val.upper()
        return None

    def _extract_recent_record_id(self, history: Optional[List[Dict[str, Any]]]) -> Optional[str]:
        """Find the most recently discussed record ID from the chat history."""
        if not history:
            return None
        for turn in reversed(history[-4:]):
            content = str(turn.get("content", ""))
            rid = self._is_order_id_query(content)
            if rid:
                return rid
        return None

    def _format_full_record_markdown(self, record_id: str, record: Dict[str, Any]) -> str:
        """Format 100% of the columns in a record as a clean Markdown presentation without truncating anything."""
        lines = [
            f"### 📋 Complete Record Details: `{record_id}`\n",
            f"Retrieved **{len(record)}** attributes for this record:\n",
            "| Attribute | Value |",
            "| :--- | :--- |"
        ]

        for key, val in record.items():
            clean_field = re.sub(r'([a-z])([A-Z])', r'\1 \2', str(key)).replace('_', ' ').strip().title()
            formatted_val = "—"
            if val is not None and str(val).strip() != "":
                if isinstance(val, float):
                    if any(t in str(key).lower() for t in ["revenue", "margin", "cost", "price", "amount", "usd", "val"]):
                        formatted_val = f"${val:,.2f}"
                    elif any(t in str(key).lower() for t in ["percent", "pct", "rate", "ratio"]):
                        formatted_val = f"{val:.2f}%"
                    else:
                        formatted_val = f"{val:,.2f}" if abs(val) >= 10 else f"{val:.4f}"
                elif isinstance(val, int):
                    formatted_val = f"{val:,}"
                else:
                    formatted_val = str(val).strip()
            lines.append(f"| **{clean_field}** | {formatted_val} |")

        return "\n".join(lines)

    def _extract_what_if_params(self, query: str) -> Optional[Dict[str, Any]]:
        """Extract what-if simulation parameters (target quantity, base quantity, order ID)."""
        q = query.strip().lower()
        if not any(k in q for k in ['what if', 'what happens', 'instead of', 'simulate', 'if i have', 'if we have']):
            return None
        order_id = self._is_order_id_query(query)
        if not order_id:
            return None

        m_instead = re.search(r'(?:only\s+)?(\d+)\s*(?:units?|pieces?|items?|qty)?\s*(?:in\s+quantity\s*(?:ordered)?)?\s*instead\s+of\s*(\d+)?', q)
        new_qty = None
        base_qty = None
        if m_instead:
            new_qty = int(m_instead.group(1))
            if m_instead.group(2):
                base_qty = int(m_instead.group(2))
        else:
            m_simple = re.search(r'(?:quantity|units?)\s*(?:is|to|=|become|at)\s*(\d+)', q)
            if m_simple:
                new_qty = int(m_simple.group(1))

        if new_qty is not None:
            return {'order_id': order_id, 'new_qty': new_qty, 'base_qty': base_qty}
        return None

    def _compute_what_if_simulation(self, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Compute financial impact simulation of changing order quantity directly from SAP HANA Cloud."""
        order_id = params['order_id']
        new_qty = params['new_qty']
        order_data = data_service.get_order_details(order_id)
        if not order_data:
            return None

        base_qty = params.get('base_qty') or int(order_data.get('Quantity') or 1)
        revenue = float(order_data.get('NetRevenueUSD') or 0)
        cost = float(order_data.get('TotalCostUSD', order_data.get('CostUSD', 0)) or 0)
        margin = float(order_data.get('GrossMarginUSD') or (revenue - cost))

        unit_price = revenue / base_qty if base_qty > 0 else float(order_data.get('NetUnitPriceUSD') or 0)
        unit_cost = cost / base_qty if base_qty > 0 else float(order_data.get('UnitCostUSD') or 0)

        sim_revenue = unit_price * new_qty
        sim_cost = unit_cost * new_qty
        sim_margin = sim_revenue - sim_cost
        sim_margin_pct = (sim_margin / sim_revenue * 100.0) if sim_revenue > 0 else 0.0

        base_margin_pct = float(order_data.get('GrossMarginPercent') or (margin / revenue * 100.0 if revenue > 0 else 0.0))
        delta_rev = sim_revenue - revenue
        delta_cost = sim_cost - cost
        delta_margin = sim_margin - margin
        delta_qty = new_qty - base_qty

        product = order_data.get('ProductName', 'N/A')
        customer = order_data.get('CustomerName', 'N/A')
        country = order_data.get('Country', 'N/A')

        def fmt_curr(val):
            return f"${val:,.2f}"

        def fmt_diff(val):
            sign = "+" if val > 0 else ""
            return f"{sign}${val:,.2f}"

        reply = (
            f"### 🔮 What-If Scenario Analysis: Order **{order_id}**\n\n"
            f"**Simulation Scenario:** Adjusting order volume from **{base_qty} units** to **{new_qty} units** "
            f"({'increased by +' if delta_qty > 0 else 'reduced by '}{delta_qty} units variance).\n\n"
            f"#### 📊 Financial Impact Simulation (SAP HANA Cloud)\n"
            f"| Metric | Baseline ({base_qty} units) | Simulated ({new_qty} units) | Variance (Δ) | Impact Analysis |\n"
            f"| :--- | :--- | :--- | :--- | :--- |\n"
            f"| **Net Revenue** | {fmt_curr(revenue)} | **{fmt_curr(sim_revenue)}** | **{fmt_diff(delta_rev)}** | {'🟢 Revenue Expansion' if delta_rev >= 0 else '🔻 Revenue Contraction'} |\n"
            f"| **Cost of Goods** | {fmt_curr(cost)} | {fmt_curr(sim_cost)} | {fmt_diff(delta_cost)} | {'🔺 Higher Total Cost' if delta_cost >= 0 else '🟢 Lower Total Cost'} |\n"
            f"| **Gross Margin ($)** | {fmt_curr(margin)} | **{fmt_curr(sim_margin)}** | **{fmt_diff(delta_margin)}** | {'🟢 Margin Expansion' if delta_margin >= 0 else '🔻 Margin Compression'} |\n"
            f"| **Gross Margin (%)** | {base_margin_pct:.2f}% | **{sim_margin_pct:.2f}%** | 0.00% | Constant unit economics |\n\n"
            f"#### 🛍️ Order & Product Context\n"
            f"- **Product:** {product}\n"
            f"- **Customer:** {customer} ({country})\n"
            f"- **Effective Unit Price:** {fmt_curr(unit_price)} / unit\n"
            f"- **Effective Unit Cost:** {fmt_curr(unit_cost)} / unit\n"
        )
        return {
            "reply": reply,
            "sources": [{
                "ID": f"what_if:{order_id}",
                "TEXT_CHUNK": f"What-If Simulation for {order_id}: Base Qty={base_qty}, Sim Qty={new_qty}, Rev Δ={fmt_diff(delta_rev)}, Margin Δ={fmt_diff(delta_margin)}",
                "SCORE": 1.0,
                "METADATA": current_source_metadata(order_id)
            }],
            "intent": "simulation"
        }

    def _is_margin_driver_query(self, query: str) -> Optional[int]:
        """Detect if query is requesting margin drivers and extract optional year."""
        q = query.lower()
        is_driver = any(k in q for k in ['driver', 'drivers', 'contributor', 'contributors', 'breakdown', 'composition'])
        is_margin = any(k in q for k in ['margin', 'margins', 'profit', 'profitability'])
        if is_driver and is_margin:
            y_match = re.search(r'\b(20\d\d)\b', q)
            return int(y_match.group(1)) if y_match else 2024
        return None

    def _compute_margin_drivers(self, year: Optional[int]) -> Optional[Dict[str, Any]]:
        """Calculate primary margin drivers directly in SAP HANA Cloud."""
        from api.database.hana_client import hana_client
        from api.platform.datasets_metadata_repository import datasets_metadata_repo
        target_year = year or 2024
        from api.models.execution_context import current_selection
        sel = current_selection.get()
        hint = sel.entry.get("physical_table_name") or sel.entry.get("name") if sel and sel.entry else None
        target_table = datasets_metadata_repo._resolve_physical_table(hint)
        sql = f'''
            SELECT CATEGORY, 
                   ROUND(SUM(NETREVENUEUSD), 2) AS REVENUE, 
                   ROUND(SUM(GROSSMARGINUSD), 2) AS MARGIN, 
                   ROUND(SUM(GROSSMARGINUSD) * 100.0 / NULLIF(SUM(NETREVENUEUSD), 0), 2) AS MARGIN_PCT 
            FROM "{target_table}" 
            WHERE YEAR = ?
            GROUP BY CATEGORY 
            ORDER BY MARGIN DESC
        '''
        rows = hana_client.execute_query(sql, (target_year,))
        if not rows:
            return None

        total_rev = sum(float(r.get('REVENUE') or 0) for r in rows)
        total_margin = sum(float(r.get('MARGIN') or 0) for r in rows)
        overall_pct = (total_margin / total_rev * 100.0) if total_rev > 0 else 0.0

        table_rows = []
        for r in rows:
            cat = r.get('CATEGORY')
            rev = float(r.get('REVENUE') or 0)
            marg = float(r.get('MARGIN') or 0)
            marg_pct = float(r.get('MARGIN_PCT') or 0)
            share_of_margin = (marg / total_margin * 100.0) if total_margin > 0 else 0.0
            table_rows.append(
                f"| **{cat}** | ${rev:,.2f} | **${marg:,.2f}** | **{marg_pct:.2f}%** | {share_of_margin:.1f}% |"
            )

        reply = (
            f"### 📈 Primary Drivers of Profit Margins ({target_year})\n\n"
            f"Here is the category-level profit margin contribution synthesized directly from the **SAP HANA Cloud** column store for fiscal year **{target_year}**:\n\n"
            f"| Product Category | Net Revenue ($) | Gross Margin ($) | Margin (%) | % of Enterprise Margin |\n"
            f"| :--- | :--- | :--- | :--- | :--- |\n"
            + "\n".join(table_rows) + "\n"
            f"| **Enterprise Total** | **${total_rev:,.2f}** | **${total_margin:,.2f}** | **{overall_pct:.2f}%** | **100.0%** |\n\n"
            f"#### 💡 Key Strategic Insights\n"
            f"- **Top Margin Contributor:** **{rows[0].get('CATEGORY')}** generated the highest absolute gross profit (${float(rows[0].get('MARGIN') or 0):,.2f}).\n"
            f"- **Highest Profitability:** The category with the highest margin efficiency is **{max(rows, key=lambda x: float(x.get('MARGIN_PCT') or 0)).get('CATEGORY')}** at **{float(max(rows, key=lambda x: float(x.get('MARGIN_PCT') or 0)).get('MARGIN_PCT') or 0):.2f}%**."
        )
        return {
            "reply": reply,
            "sources": [{
                "ID": f"drivers:{target_year}",
                "TEXT_CHUNK": f"Margin Drivers {target_year}: Top={rows[0].get('CATEGORY')}, Total Margin=${total_margin:,.2f}, Overall={overall_pct:.2f}%",
                "SCORE": 1.0,
                "METADATA": json.dumps({"source": "SAP HANA Cloud In-Memory Aggregation", "year": target_year})
            }],
            "intent": "analytical"
        }

    def _is_product_catalog_query(self, query: str) -> bool:
        """Detect if query is requesting the list or catalog of products."""
        q = query.lower()
        patterns = [
            'all products', 'all the products', 'list of products', 'product list',
            'what products', 'which products', 'products i have', 'products do we have',
            'available products', 'our products', 'catalog of products'
        ]
        return any(p in q for p in patterns)

    def _compute_product_catalog(self) -> Optional[Dict[str, Any]]:
        """Fetch distinct product catalog grouped by category from SAP HANA Cloud."""
        from api.database.hana_client import hana_client
        from api.platform.datasets_metadata_repository import datasets_metadata_repo
        from api.models.execution_context import current_selection
        sel = current_selection.get()
        hint = sel.entry.get("physical_table_name") or sel.entry.get("name") if sel and sel.entry else None
        target_table = datasets_metadata_repo._resolve_physical_table(hint)
        sql = f'''
            SELECT CATEGORY, PRODUCTNAME, COUNT(*) AS ORDER_COUNT, ROUND(SUM(NETREVENUEUSD), 2) AS TOTAL_REVENUE
            FROM "{target_table}"
            GROUP BY CATEGORY, PRODUCTNAME
            ORDER BY CATEGORY, TOTAL_REVENUE DESC
        '''
        rows = hana_client.execute_query(sql)
        if not rows:
            return None

        # Group by category for an executive breakdown
        by_cat: Dict[str, List] = {}
        for r in rows:
            cat = r.get('CATEGORY') or 'General'
            if cat not in by_cat:
                by_cat[cat] = []
            by_cat[cat].append(r)

        category_sections = []
        for cat, prods in by_cat.items():
            prod_lines = [
                f"| **{p.get('PRODUCTNAME')}** | {p.get('ORDER_COUNT'):,} | ${float(p.get('TOTAL_REVENUE') or 0):,.2f} |"
                for p in prods[:10]  # Show top 10 per category for executive readability
            ]
            section = (
                f"#### 🏷️ {cat} ({len(prods)} Products)\n"
                f"| Product Name | Transactions | Total Net Revenue |\n"
                f"| :--- | :--- | :--- |\n"
                + "\n".join(prod_lines)
            )
            category_sections.append(section)

        reply = (
            f"### 📦 Enterprise Product Catalog\n\n"
            f"Retrieved **{len(rows)} distinct enterprise products** across **{len(by_cat)} categories** directly from **SAP HANA Cloud**:\n\n"
            + "\n\n".join(category_sections)
            + f"\n\n*Note: Top products by revenue are displayed per category. Full catalog contains {len(rows)} SKUs across all business units.*"
        )
        return {
            "reply": reply,
            "sources": [{
                "ID": "product_catalog",
                "TEXT_CHUNK": f"Enterprise Product Catalog: {len(rows)} products across {len(by_cat)} categories",
                "SCORE": 1.0,
                "METADATA": json.dumps({"source": "SAP HANA Cloud Distinct Catalog", "count": len(rows)})
            }],
            "intent": "analytical"
        }

    def _is_pure_order_lookup(self, query: str) -> bool:
        """Check if query is asking to display, lookup, or ask questions about a specific record."""
        q = query.strip().lower()
        analytical_keywords = [
            "what if", "what happens", "if i have", "if we", "suppose", "assume",
            "calculate", "recalculate", "simulate", "impact", "difference", "compare to",
            "instead of", "reduced to", "increased to", "across all", "versus average",
            "units instead", "quantity instead"
        ]
        if any(kw in q for kw in analytical_keywords):
            return False

        return True

    def _get_exact_order_data(self, order_id: str) -> Dict[str, Any]:
        """Get exact record data dynamically from DataService with full field disclosure."""
        order_data = data_service.get_order_details(order_id)
        if order_data:
            rows = []
            for k, v in order_data.items():
                if str(k).startswith("_"):
                    continue
                val_str = str(v)
                if isinstance(v, float):
                    val_str = f"{v:,.2f}"
                elif isinstance(v, int):
                    val_str = f"{v:,}"
                rows.append(f"| **{k}** | {val_str} |")

            table_markdown = (
                f"### 📦 Record Details: **{order_id}**\n\n"
                f"Here is the complete record retrieved dynamically from the active dataset:\n\n"
                f"| Attribute | Value |\n"
                f"| :--- | :--- |\n"
                + "\n".join(rows)
            )

            summary_items = [f"{k}={v}" for k, v in list(order_data.items())[:6] if not str(k).startswith("_")]
            summary_str = f"Record {order_id}: " + ", ".join(summary_items)

            return {
                "reply": table_markdown,
                "sources": [{
                    "ID": str(order_id),
                    "TEXT_CHUNK": summary_str,
                    "SCORE": 1.0,
                    "METADATA": current_source_metadata(order_id)
                }],
                "intent": "exact_order"
            }
        return None

    def _extract_what_if_params(self, query: str) -> Optional[Dict[str, Any]]:
        """Extract what-if simulation parameters (target quantity, base quantity, order ID)."""
        q = query.strip().lower()
        if not any(k in q for k in ['what if', 'what happens', 'instead of', 'simulate', 'if i have', 'if we have']):
            return None
        m_order = re.search(r'\b(SO-\d+)\b', query, re.IGNORECASE)
        if not m_order:
            return None
        order_id = m_order.group(1).upper()

        m_instead = re.search(r'(?:only\s+)?(\d+)\s*(?:units?|pieces?|items?|qty)?\s*(?:in\s+quantity\s*(?:ordered)?)?\s*instead\s+of\s*(\d+)?', q)
        new_qty = None
        base_qty = None
        if m_instead:
            new_qty = int(m_instead.group(1))
            if m_instead.group(2):
                base_qty = int(m_instead.group(2))
        else:
            m_simple = re.search(r'(?:quantity|units?)\s*(?:is|to|=|become|at)\s*(\d+)', q)
            if m_simple:
                new_qty = int(m_simple.group(1))

        if new_qty is not None:
            return {'order_id': order_id, 'new_qty': new_qty, 'base_qty': base_qty}
        return None

    def _compute_what_if_simulation(self, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Compute financial impact simulation of changing order quantity directly from SAP HANA Cloud."""
        order_id = params['order_id']
        new_qty = params['new_qty']
        order_data = data_service.get_order_details(order_id)
        if not order_data:
            return None

        base_qty = params.get('base_qty') or int(order_data.get('Quantity') or 1)
        revenue = float(order_data.get('NetRevenueUSD') or 0)
        cost = float(order_data.get('TotalCostUSD', order_data.get('CostUSD', 0)) or 0)
        margin = float(order_data.get('GrossMarginUSD') or (revenue - cost))

        unit_price = revenue / base_qty if base_qty > 0 else float(order_data.get('NetUnitPriceUSD') or 0)
        unit_cost = cost / base_qty if base_qty > 0 else float(order_data.get('UnitCostUSD') or 0)

        sim_revenue = unit_price * new_qty
        sim_cost = unit_cost * new_qty
        sim_margin = sim_revenue - sim_cost
        sim_margin_pct = (sim_margin / sim_revenue * 100.0) if sim_revenue > 0 else 0.0

        base_margin_pct = float(order_data.get('GrossMarginPercent') or (margin / revenue * 100.0 if revenue > 0 else 0.0))
        delta_rev = sim_revenue - revenue
        delta_cost = sim_cost - cost
        delta_margin = sim_margin - margin
        delta_qty = new_qty - base_qty

        product = order_data.get('ProductName', 'N/A')
        customer = order_data.get('CustomerName', 'N/A')
        country = order_data.get('Country', 'N/A')

        def fmt_curr(val):
            return f"${val:,.2f}"

        def fmt_diff(val):
            sign = "+" if val > 0 else ""
            return f"{sign}${val:,.2f}"

        reply = (
            f"### 🔮 What-If Scenario Analysis: Order **{order_id}**\n\n"
            f"**Simulation Scenario:** Adjusting order volume from **{base_qty} units** to **{new_qty} units** "
            f"({'increased by +' if delta_qty > 0 else 'reduced by '}{delta_qty} units variance).\n\n"
            f"#### 📊 Financial Impact Simulation (SAP HANA Cloud)\n"
            f"| Metric | Baseline ({base_qty} units) | Simulated ({new_qty} units) | Variance (Δ) | Impact Analysis |\n"
            f"| :--- | :--- | :--- | :--- | :--- |\n"
            f"| **Net Revenue** | {fmt_curr(revenue)} | **{fmt_curr(sim_revenue)}** | **{fmt_diff(delta_rev)}** | {'🟢 Revenue Expansion' if delta_rev >= 0 else '🔻 Revenue Contraction'} |\n"
            f"| **Cost of Goods** | {fmt_curr(cost)} | {fmt_curr(sim_cost)} | {fmt_diff(delta_cost)} | {'🔺 Higher Total Cost' if delta_cost >= 0 else '🟢 Lower Total Cost'} |\n"
            f"| **Gross Margin ($)** | {fmt_curr(margin)} | **{fmt_curr(sim_margin)}** | **{fmt_diff(delta_margin)}** | {'🟢 Margin Expansion' if delta_margin >= 0 else '🔻 Margin Compression'} |\n"
            f"| **Gross Margin (%)** | {base_margin_pct:.2f}% | **{sim_margin_pct:.2f}%** | 0.00% | Constant unit economics |\n\n"
            f"#### 🛍️ Order & Product Context\n"
            f"- **Product:** {product}\n"
            f"- **Customer:** {customer} ({country})\n"
            f"- **Effective Unit Price:** {fmt_curr(unit_price)} / unit\n"
            f"- **Effective Unit Cost:** {fmt_curr(unit_cost)} / unit\n"
        )
        return {
            "reply": reply,
            "sources": [{
                "ID": f"what_if:{order_id}",
                "TEXT_CHUNK": f"What-If Simulation for {order_id}: Base Qty={base_qty}, Sim Qty={new_qty}, Rev Δ={fmt_diff(delta_rev)}, Margin Δ={fmt_diff(delta_margin)}",
                "SCORE": 1.0,
                "METADATA": current_source_metadata(order_id)
            }],
            "intent": "simulation"
        }

    # ── Main Pipeline ─────────────────────────────────────────────────────────

    def run(self, user_message: str, top_k: int = 15,
            event_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
            chat_history: Optional[List[Dict[str, str]]] = None) -> Dict[str, Any]:
        """
        Enhanced hybrid RAG pipeline with intent detection and structured analytics.
        Returns a dict compatible with both ChatResponse and EnhancedChatResponse.
        Accepts an optional event_callback for real-time stage streaming.
        Accepts an optional chat_history for multi-turn conversation context.
        """
        return self._run_scoped(user_message, top_k, event_callback, chat_history, stream=False)
        ctx = RequestContext()
        processing_steps = []
        cb = event_callback
        self._chat_history = chat_history or []

        try:
            # ── Stage 1: Check for Order ID lookup (preserved) ────────────────
            order_id = self._is_order_id_query(user_message)
            if order_id and self._is_pure_order_lookup(user_message):
                self._emit(cb, "intent", "running", "Analyzing prompt intent...")
                self._emit(cb, "intent", "completed", "Detected order lookup request.")
                self._emit(cb, "retrieval", "running", f"Retrieving order {order_id}...")
                exact_data = self._get_exact_order_data(order_id)
                if exact_data:
                    self._emit(cb, "retrieval", "completed", f"Retrieved order {order_id} from source data.")
                    exact_data["processing"] = [
                        {"stage": "intent", "status": "completed", "message": "Detected order lookup request."},
                        {"stage": "retrieval", "status": "completed", "message": f"Retrieved order {order_id} from source data."},
                    ]
                    exact_data["type"] = "analytical"
                    exact_data["status"] = "success"
                    exact_data["records_matched"] = 1
                    ctx.intent = "exact_order"
                    ctx.records_matched = 1
                    ctx.finalize("success")
                    return exact_data

            # ── Fast-path 2: Dynamic What-If Simulation (< 5ms, 0 LLM tokens) ────
            what_if_params = self._extract_what_if_params(user_message)
            if what_if_params:
                self._emit(cb, "intent", "completed", f"Verified intent: What-If Scenario Simulation for {what_if_params['order_id']}.")
                sim_result = self._compute_what_if_simulation(what_if_params)
                if sim_result:
                    sim_result["processing"] = [
                        {"stage": "intent", "status": "completed", "message": f"Verified intent: What-If Scenario Simulation for {what_if_params['order_id']}."},
                        {"stage": "calculation", "status": "completed", "message": "Calculated financial variance in SAP HANA Cloud."},
                    ]
                    sim_result["type"] = "analytical"
                    sim_result["status"] = "success"
                    sim_result["records_matched"] = 1
                    ctx.intent = "simulation"
                    ctx.finalize("success")
                    return sim_result

            # ── Fast-path 3: Profit Margin Drivers Analysis ────
            margin_year = self._is_margin_driver_query(user_message)
            if margin_year:
                self._emit(cb, "intent", "completed", f"Verified intent: Profit Margin Drivers Analysis ({margin_year}).")
                drivers_result = self._compute_margin_drivers(margin_year)
                if drivers_result:
                    drivers_result["processing"] = [
                        {"stage": "intent", "status": "completed", "message": f"Verified intent: Profit Margin Drivers Analysis ({margin_year})."},
                        {"stage": "calculation", "status": "completed", "message": "Aggregated category profit margins in SAP HANA Cloud."},
                    ]
                    drivers_result["type"] = "analytical"
                    drivers_result["status"] = "success"
                    ctx.intent = "analytical"
                    ctx.finalize("success")
                    return drivers_result

            # ── Fast-path 4: Distinct Product Catalog Listing ────
            if self._is_product_catalog_query(user_message):
                self._emit(cb, "intent", "completed", "Verified intent: Distinct Product Catalog Listing.")
                catalog_result = self._compute_product_catalog()
                if catalog_result:
                    catalog_result["processing"] = [
                        {"stage": "intent", "status": "completed", "message": "Verified intent: Distinct Product Catalog Listing."},
                        {"stage": "retrieval", "status": "completed", "message": "Retrieved enterprise product catalog from SAP HANA Cloud."},
                    ]
                    catalog_result["type"] = "analytical"
                    catalog_result["status"] = "success"
                    ctx.intent = "analytical"
                    ctx.finalize("success")
                    return catalog_result

            # ── Stage 2: Intent Detection ─────────────────────────────────────
            self._emit(cb, "intent", "running", "Analyzing prompt intent...")
            step = {"stage": "intent", "status": "running", "message": "Analyzing prompt intent..."}
            processing_steps.append(step)

            t0 = time.time()
            query_plan = intent_engine.classify(user_message)
            ctx.intent_time_ms = (time.time() - t0) * 1000
            ctx.intent = query_plan.get("intent")
            ctx.metric = query_plan.get("metric")
            ctx.dimension = query_plan.get("dimension")
            ctx.filters = query_plan.get("filters", [])

            intent = query_plan.get("intent", "chat")
            metric = query_plan.get("metric")
            dimension = query_plan.get("dimension")

            # Build intent description for UI
            intent_desc = self._describe_intent(query_plan)
            step["status"] = "completed"
            step["message"] = intent_desc
            step["details"] = {
                "intent": intent,
                "metric": metric,
                "dimension": dimension,
                "chart_type": query_plan.get("chart_type"),
            }
            self._emit(cb, "intent", "completed", intent_desc, details=step["details"])

            # ── Stage 3: Route by intent ──────────────────────────────────────

            if intent == "graph":
                return self._handle_graph(user_message, query_plan, processing_steps, ctx, top_k, cb)

            elif intent in ("analytical", "ranking", "comparison"):
                return self._handle_analytical(user_message, query_plan, processing_steps, ctx, top_k, cb)

            else:
                return self._handle_chat(user_message, query_plan, processing_steps, ctx, top_k, order_id, cb)

        except Exception as e:
            logger.error(f"[Pipeline] Error: {e}")
            ctx.error = str(e)
            ctx.finalize("error")
            return {
                "reply": f"I encountered an error processing your request. Please try rephrasing your question.",
                "sources": [],
                "intent": "error",
                "type": "error",
                "status": "error",
                "processing": processing_steps + [
                    {"stage": "error", "status": "error", "message": "An internal error occurred."}
                ],
                "session_id": "default",
            }

    # ── Streaming Pipeline (Token-by-Token via SSE) ───────────────────────────

    def run_stream(self, user_message: str, top_k: int = 15,
                   event_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
                   chat_history: Optional[List[Dict[str, str]]] = None,
                   stop_event: Optional[Any] = None) -> Dict[str, Any]:
        """
        Streaming variant of run(). Routes to _run_scoped with stream=True for
        token-by-token streaming via NVIDIA NIM.
        """
        return self._run_scoped(user_message, top_k, event_callback, chat_history, stream=True, stop_event=stop_event)
        ctx = RequestContext()
        processing_steps = []
        cb = event_callback
        self._chat_history = chat_history or []

        try:
            # ── Stage 1: Check for Order ID lookup ────────────────────────────
            order_id = self._is_order_id_query(user_message)
            if order_id and self._is_pure_order_lookup(user_message):
                self._emit(cb, "intent", "running", "Analyzing prompt intent...")
                self._emit(cb, "intent", "completed", "Detected order lookup request.")
                self._emit(cb, "retrieval", "running", f"Retrieving order {order_id}...")
                exact_data = self._get_exact_order_data(order_id)
                if exact_data:
                    self._emit(cb, "retrieval", "completed", f"Retrieved order {order_id} from source data.")
                    exact_data["processing"] = [
                        {"stage": "intent", "status": "completed", "message": "Detected order lookup request."},
                        {"stage": "retrieval", "status": "completed", "message": f"Retrieved order {order_id} from source data."},
                    ]
                    exact_data["type"] = "analytical"
                    exact_data["status"] = "success"
                    exact_data["records_matched"] = 1
                    ctx.intent = "exact_order"
                    ctx.records_matched = 1
                    ctx.finalize("success")
                    return exact_data

            # ── Fast-path 2: Dynamic What-If Simulation (< 5ms, 0 LLM tokens) ────
            what_if_params = self._extract_what_if_params(user_message)
            if what_if_params:
                self._emit(cb, "intent", "completed", f"Verified intent: What-If Scenario Simulation for {what_if_params['order_id']}.")
                sim_result = self._compute_what_if_simulation(what_if_params)
                if sim_result:
                    sim_result["processing"] = [
                        {"stage": "intent", "status": "completed", "message": f"Verified intent: What-If Scenario Simulation for {what_if_params['order_id']}."},
                        {"stage": "calculation", "status": "completed", "message": "Calculated financial variance in SAP HANA Cloud."},
                    ]
                    sim_result["type"] = "analytical"
                    sim_result["status"] = "success"
                    sim_result["records_matched"] = 1
                    ctx.intent = "simulation"
                    ctx.finalize("success")
                    return sim_result

            # ── Fast-path 3: Profit Margin Drivers Analysis ────
            margin_year = self._is_margin_driver_query(user_message)
            if margin_year:
                self._emit(cb, "intent", "completed", f"Verified intent: Profit Margin Drivers Analysis ({margin_year}).")
                drivers_result = self._compute_margin_drivers(margin_year)
                if drivers_result:
                    drivers_result["processing"] = [
                        {"stage": "intent", "status": "completed", "message": f"Verified intent: Profit Margin Drivers Analysis ({margin_year})."},
                        {"stage": "calculation", "status": "completed", "message": "Aggregated category profit margins in SAP HANA Cloud."},
                    ]
                    drivers_result["type"] = "analytical"
                    drivers_result["status"] = "success"
                    ctx.intent = "analytical"
                    ctx.finalize("success")
                    return drivers_result

            # ── Fast-path 4: Distinct Product Catalog Listing ────
            if self._is_product_catalog_query(user_message):
                self._emit(cb, "intent", "completed", "Verified intent: Distinct Product Catalog Listing.")
                catalog_result = self._compute_product_catalog()
                if catalog_result:
                    catalog_result["processing"] = [
                        {"stage": "intent", "status": "completed", "message": "Verified intent: Distinct Product Catalog Listing."},
                        {"stage": "retrieval", "status": "completed", "message": "Retrieved enterprise product catalog from SAP HANA Cloud."},
                    ]
                    catalog_result["type"] = "analytical"
                    catalog_result["status"] = "success"
                    ctx.intent = "analytical"
                    ctx.finalize("success")
                    return catalog_result

            # ── Stage 2: Intent Detection ─────────────────────────────────────
            self._emit(cb, "intent", "running", "Analyzing prompt intent...")
            step = {"stage": "intent", "status": "running", "message": "Analyzing prompt intent..."}
            processing_steps.append(step)

            t0 = time.time()
            query_plan = intent_engine.classify(user_message)
            ctx.intent_time_ms = (time.time() - t0) * 1000
            ctx.intent = query_plan.get("intent")
            ctx.metric = query_plan.get("metric")
            ctx.dimension = query_plan.get("dimension")
            ctx.filters = query_plan.get("filters", [])

            intent = query_plan.get("intent", "chat")
            metric = query_plan.get("metric")
            dimension = query_plan.get("dimension")

            intent_desc = self._describe_intent(query_plan)
            step["status"] = "completed"
            step["message"] = intent_desc
            step["details"] = {
                "intent": intent,
                "metric": metric,
                "dimension": dimension,
                "chart_type": query_plan.get("chart_type"),
            }
            self._emit(cb, "intent", "completed", intent_desc, details=step["details"])

            # ── Stage 3: Route by intent ──────────────────────────────────────

            if intent == "graph":
                # Graph generation uses SAP AI Core (non-streaming REST)
                return self._handle_graph(user_message, query_plan, processing_steps, ctx, top_k, cb)

            elif intent in ("analytical", "ranking", "comparison"):
                return self._handle_analytical_stream(user_message, query_plan, processing_steps, ctx, top_k, cb, stop_event=stop_event)

            else:
                return self._handle_chat_stream(user_message, query_plan, processing_steps, ctx, top_k, order_id, cb, stop_event=stop_event)

        except Exception as e:
            logger.error(f"[Pipeline] Stream error: {e}")
            ctx.error = str(e)
            ctx.finalize("error")
            return {
                "reply": "I encountered an error processing your request. Please try rephrasing your question.",
                "sources": [],
                "intent": "error",
                "type": "error",
                "status": "error",
                "processing": processing_steps + [
                    {"stage": "error", "status": "error", "message": "An internal error occurred."}
                ],
                "session_id": "default",
            }

    # ── Graph Handler ─────────────────────────────────────────────────────────

    def _handle_graph(self, user_message: str, plan: Dict[str, Any],
                      steps: List, ctx: RequestContext, top_k: int,
                      cb: Optional[Callable] = None) -> Dict[str, Any]:
        """Handle graph generation requests with pre-validated data."""

        meta = schema_service.get_metadata()
        default_metric = next((k for k, v in meta.items() if getattr(v, "is_measure", False) or getattr(v, "type", "") == "number"), "NetRevenueUSD")
        metric = plan.get("metric") or default_metric
        dimension = plan.get("dimension")
        chart_type = plan.get("chart_type", "bar")

        # Stage: Schema validation
        self._emit(cb, "schema", "running", "Identifying dimensions and measures...")
        step_schema = {"stage": "schema", "status": "running", "message": "Identifying dimensions and measures..."}
        steps.append(step_schema)

        if metric and metric in meta:
            step_schema["status"] = "completed"
            step_schema["message"] = f"Metric: {metric}, Dimension: {dimension or 'auto'}"
        else:
            step_schema["status"] = "completed"
            step_schema["message"] = f"Using metric: {default_metric}"
            metric = default_metric
        self._emit(cb, "schema", "completed", step_schema["message"])

        # Stage: Apply filters
        if plan.get("filters") or plan.get("date_filter"):
            self._emit(cb, "filter", "running", "Applying filters...")
            step_filter = {"stage": "filter", "status": "running", "message": "Applying filters..."}
            steps.append(step_filter)
            filter_desc = self._describe_filters(plan)
            step_filter["status"] = "completed"
            step_filter["message"] = filter_desc
            self._emit(cb, "filter", "completed", filter_desc)

        # Stage: Generate graph
        self._emit(cb, "generation", "running", "Generating visualization...")
        step_gen = {"stage": "generation", "status": "running", "message": "Generating visualization..."}
        steps.append(step_gen)

        t0 = time.time()
        graph_res = python_graph_agent.generate_custom_graph(user_message, query_plan=plan)
        ctx.graph_time_ms = (time.time() - t0) * 1000

        if graph_res.get("status") == "success" and graph_res.get("image_base64"):
            step_gen["status"] = "completed"
            step_gen["message"] = f"Generated {chart_type.replace('_', ' ')} chart."
            self._emit(cb, "generation", "completed", step_gen["message"])
            ctx.records_matched = graph_res.get("records_matched", 0)

            reply_text = (
                f"I have analyzed the dataset and generated the requested visualization.\n\n"
                f"**Key Insights:**\n{graph_res.get('insights', '')}"
            )

            ctx.finalize("success")
            return {
                "reply": reply_text,
                "sources": [],
                "graph_image": graph_res.get("image_base64"),
                "chart_type": graph_res.get("chart_type", chart_type),
                "insights": graph_res.get("insights"),
                "intent": "graph",
                "type": "graph",
                "status": "success",
                "processing": steps,
                "query_plan": plan,
                "records_matched": ctx.records_matched,
                "session_id": "default",
            }
        else:
            step_gen["status"] = "error"
            step_gen["message"] = graph_res.get("message", "Graph generation failed.")
            self._emit(cb, "generation", "failed", step_gen["message"], error=step_gen["message"])
            ctx.error = graph_res.get("message")
            ctx.finalize("error")
            return {
                "reply": f"I couldn't generate the graph: {graph_res.get('message', 'Unknown error')}",
                "sources": [],
                "intent": "graph",
                "type": "error",
                "status": "error",
                "processing": steps,
                "session_id": "default",
            }

    # ── Analytical Handler ────────────────────────────────────────────────────

    def _handle_analytical(self, user_message: str, plan: Dict[str, Any],
                          steps: List, ctx: RequestContext, top_k: int,
                          cb: Optional[Callable] = None) -> Dict[str, Any]:
        """Handle analytical/ranking/comparison requests with structured data."""

        meta = schema_service.get_metadata()
        default_metric = next((k for k, v in meta.items() if getattr(v, "is_measure", False) or getattr(v, "type", "") == "number"), "NetRevenueUSD")
        metric = plan.get("metric") or default_metric
        dimension = plan.get("dimension")
        aggregation = plan.get("aggregation", "SUM")

        # Stage: Schema
        self._emit(cb, "schema", "running", "Understanding dataset schema...")
        schema_msg = (f"Metric: {metric} ({aggregation})" +
                      (f", grouped by {dimension}" if dimension else ""))
        step_schema = {"stage": "schema", "status": "completed", "message": schema_msg}
        steps.append(step_schema)
        self._emit(cb, "schema", "completed", schema_msg)

        # Stage: Filters
        if plan.get("filters") or plan.get("date_filter"):
            self._emit(cb, "filter", "running", "Applying filters...")
            filter_desc = self._describe_filters(plan)
            steps.append({"stage": "filter", "status": "completed", "message": filter_desc})
            self._emit(cb, "filter", "completed", filter_desc)

        # Stage: Retrieval & Calculation
        calc_running_msg = f"Calculating {aggregation}({metric})..."
        self._emit(cb, "calculation", "running", calc_running_msg)
        step_calc = {"stage": "calculation", "status": "running", "message": calc_running_msg}
        steps.append(step_calc)

        t0 = time.time()
        analytics_result = analytics_engine.execute(plan)
        ctx.analytics_time_ms = (time.time() - t0) * 1000
        ctx.records_matched = analytics_result.records_matched

        if not analytics_result.success:
            step_calc["status"] = "error"
            step_calc["message"] = analytics_result.error or "Calculation failed."
            self._emit(cb, "calculation", "failed", step_calc["message"], error=step_calc["message"])
            ctx.error = analytics_result.error
            ctx.finalize("error")
            return {
                "reply": analytics_result.error or "Unable to calculate the requested data.",
                "sources": [],
                "intent": plan["intent"],
                "type": "error",
                "status": "error",
                "processing": steps,
                "session_id": "default",
            }

        step_calc["status"] = "completed"
        step_calc["message"] = f"Calculated from {analytics_result.records_matched:,} matching records."
        self._emit(cb, "calculation", "completed", step_calc["message"])

        # Stage: Vector Retrieval
        self._emit(cb, "retrieval", "running", "Searching SAP HANA Cloud Vector DB...")
        step_vec = {"stage": "retrieval", "status": "running", "message": "Searching SAP HANA Cloud Vector DB..."}
        steps.append(step_vec)

        t_vec = time.time()
        vector_chunks = retriever.retrieve(user_message, top_k)
        ctx.retrieval_time_ms = (time.time() - t_vec) * 1000
        top_score = max((float(c.get("SCORE", 0)) for c in vector_chunks if isinstance(c.get("SCORE"), (int, float))), default=None)
        score_msg = f" (HANA Cosine Sim: {top_score:.3f})" if top_score is not None else ""
        step_vec["status"] = "completed"
        step_vec["message"] = f"Retrieved {len(vector_chunks)} relevant context chunks from SAP HANA Cloud Vector Engine{score_msg}."
        self._emit(cb, "retrieval", "completed", step_vec["message"], details={"engine": "SAP HANA Cloud Vector Engine", "top_score": round(top_score, 3) if top_score is not None else "N/A"})

        # Stage: LLM explanation
        self._emit(cb, "explanation", "running", "Preparing answer...")
        step_llm = {"stage": "explanation", "status": "running", "message": "Preparing answer..."}
        steps.append(step_llm)

        t0 = time.time()
        analytics_ctx = self._format_analytics_as_context(plan, analytics_result)
        formatted_prompt = prompt_builder.build_prompt(
            user_message, vector_chunks, chat_history=self._chat_history, analytics_context=analytics_ctx
        )
        reply = generator.generate(formatted_prompt)
        ctx.llm_time_ms = (time.time() - t0) * 1000
        step_llm["status"] = "completed"
        step_llm["message"] = "Response generated from Vector DB."
        self._emit(cb, "explanation", "completed", "Answer prepared.")

        ctx.finalize("success")
        return {
            "reply": reply,
            "sources": vector_chunks,
            "intent": plan["intent"],
            "type": "analytical",
            "status": "success",
            "processing": steps,
            "cosine_score": round(top_score, 3) if top_score is not None else None,
            "data": analytics_result.to_dict(),
            "query_plan": plan,
            "records_matched": analytics_result.records_matched,
            "session_id": "default",
        }

    # ── Analytical Handler (Streaming) ────────────────────────────────────────

    def _handle_analytical_stream(self, user_message: str, plan: Dict[str, Any],
                                  steps: List, ctx: RequestContext, top_k: int,
                                  cb: Optional[Callable] = None,
                                  stop_event: Optional[Any] = None) -> Dict[str, Any]:
        """
        Streaming variant of _handle_analytical.
        Uses generate_stream() and emits token events during LLM generation.
        """
        metric = plan.get("metric", "NetRevenueUSD")
        dimension = plan.get("dimension")
        aggregation = plan.get("aggregation", "SUM")

        # Stage: Schema
        self._emit(cb, "schema", "running", "Understanding dataset schema...")
        schema_msg = (f"Metric: {metric} ({aggregation})" +
                      (f", grouped by {dimension}" if dimension else ""))
        step_schema = {"stage": "schema", "status": "completed", "message": schema_msg}
        steps.append(step_schema)
        self._emit(cb, "schema", "completed", schema_msg)

        # Stage: Filters
        if plan.get("filters") or plan.get("date_filter"):
            self._emit(cb, "filter", "running", "Applying filters...")
            filter_desc = self._describe_filters(plan)
            steps.append({"stage": "filter", "status": "completed", "message": filter_desc})
            self._emit(cb, "filter", "completed", filter_desc)

        # Stage: Retrieval & Calculation
        calc_running_msg = f"Calculating {aggregation}({metric})..."
        self._emit(cb, "calculation", "running", calc_running_msg)
        step_calc = {"stage": "calculation", "status": "running", "message": calc_running_msg}
        steps.append(step_calc)

        t0 = time.time()
        analytics_result = analytics_engine.execute(plan)
        ctx.analytics_time_ms = (time.time() - t0) * 1000
        ctx.records_matched = analytics_result.records_matched

        if not analytics_result.success:
            step_calc["status"] = "error"
            step_calc["message"] = analytics_result.error or "Calculation failed."
            self._emit(cb, "calculation", "failed", step_calc["message"], error=step_calc["message"])
            ctx.error = analytics_result.error
            ctx.finalize("error")
            return {
                "reply": analytics_result.error or "Unable to calculate the requested data.",
                "sources": [],
                "intent": plan["intent"],
                "type": "error",
                "status": "error",
                "processing": steps,
                "session_id": "default",
            }

        step_calc["status"] = "completed"
        step_calc["message"] = f"Calculated from {analytics_result.records_matched:,} matching records."
        self._emit(cb, "calculation", "completed", step_calc["message"])

        # Stage: Vector Retrieval
        self._emit(cb, "retrieval", "running", "Searching SAP HANA Cloud Vector DB...")
        step_vec = {"stage": "retrieval", "status": "running", "message": "Searching SAP HANA Cloud Vector DB..."}
        steps.append(step_vec)

        t_vec = time.time()
        vector_chunks = retriever.retrieve(user_message, top_k)
        ctx.retrieval_time_ms = (time.time() - t_vec) * 1000
        top_score = max((float(c.get("SCORE", 0)) for c in vector_chunks if isinstance(c.get("SCORE"), (int, float))), default=None)
        score_msg = f" (HANA Cosine Sim: {top_score:.3f})" if top_score is not None else ""
        step_vec["status"] = "completed"
        step_vec["message"] = f"Retrieved {len(vector_chunks)} relevant context chunks from SAP HANA Cloud Vector Engine{score_msg}."
        self._emit(cb, "retrieval", "completed", step_vec["message"], details={"engine": "SAP HANA Cloud Vector Engine", "top_score": round(top_score, 3) if top_score is not None else "N/A"})

        # Stage: LLM explanation (STREAMING)
        self._emit(cb, "explanation", "running", "Generating answer via NVIDIA NIM...")
        step_llm = {"stage": "explanation", "status": "running", "message": "Generating answer via NVIDIA NIM..."}
        steps.append(step_llm)

        t0 = time.time()
        analytics_ctx = self._format_analytics_as_context(plan, analytics_result)
        formatted_prompt = prompt_builder.build_prompt(
            user_message, vector_chunks, chat_history=self._chat_history, analytics_context=analytics_ctx
        )

        # Stream tokens and accumulate full response
        full_response_parts = []
        for token in generator.generate_stream(formatted_prompt, stop_event=stop_event):
            full_response_parts.append(token)
            self._emit_token(cb, token)

        reply = "".join(full_response_parts)
        ctx.llm_time_ms = (time.time() - t0) * 1000
        step_llm["status"] = "completed"
        step_llm["message"] = "Response generated from Vector DB."
        self._emit(cb, "explanation", "completed", "Answer prepared.")

        ctx.finalize("success")
        return {
            "reply": reply,
            "sources": vector_chunks,
            "intent": plan["intent"],
            "type": "analytical",
            "status": "success",
            "processing": steps,
            "cosine_score": round(top_score, 3) if top_score is not None else None,
            "data": analytics_result.to_dict(),
            "query_plan": plan,
            "records_matched": analytics_result.records_matched,
            "session_id": "default",
        }

    # ── Chat Handler ──────────────────────────────────────────────────────────

    def _handle_chat(self, user_message: str, plan: Dict[str, Any],
                     steps: List, ctx: RequestContext, top_k: int,
                     order_id: str = None,
                     cb: Optional[Callable] = None) -> Dict[str, Any]:
        """Handle semantic chat/RAG requests, optionally with structured data."""

        context_chunks = []
        analytics_data = None

        # If plan indicates structured query is also needed
        if plan.get("requires_structured_query") and plan.get("metric"):
            self._emit(cb, "calculation", "running", "Retrieving data from source...")
            step_calc = {"stage": "calculation", "status": "running",
                        "message": "Retrieving data from source..."}
            steps.append(step_calc)

            t0 = time.time()
            analytics_result = analytics_engine.execute(plan)
            ctx.analytics_time_ms = (time.time() - t0) * 1000

            if analytics_result.success and analytics_result.data:
                analytics_data = analytics_result
                ctx.records_matched = analytics_result.records_matched
                step_calc["status"] = "completed"
                step_calc["message"] = f"Calculated metadata for {analytics_result.records_matched:,} records."
                self._emit(cb, "calculation", "completed", step_calc["message"])
            else:
                step_calc["status"] = "completed"
                step_calc["message"] = "No additional metadata needed for this query."
                self._emit(cb, "calculation", "completed", step_calc["message"])

        # If order_id with analytical context (what-if scenarios)
        if order_id and not self._is_pure_order_lookup(user_message):
            order_data = data_service.get_order_details(order_id)
            if order_data:
                revenue = float(order_data.get('NetRevenueUSD', 0) or 0)
                cost = float(order_data.get('TotalCostUSD', order_data.get('CostUSD', 0)) or 0)
                margin = float(order_data.get('GrossMarginUSD', 0) or 0)
                margin_pct = float(order_data.get('GrossMarginPercent', 0) or 0)
                qty = int(order_data.get('Quantity', 1) or 1)
                unit_price = (revenue / qty) if qty > 0 else 0
                unit_cost = (cost / qty) if qty > 0 else 0
                unit_margin = (margin / qty) if qty > 0 else 0

                order_context_chunk = {
                    "ID": order_id,
                    "TEXT_CHUNK": (
                        f"Exact Order Data for {order_id}: "
                        f"Product Name: {order_data.get('ProductName', 'N/A')}, "
                        f"Category: {order_data.get('Category', 'N/A')}, SubCategory: {order_data.get('SubCategory', order_data.get('Subcategory', 'N/A'))}, "
                        f"Customer: {order_data.get('CustomerName', 'N/A')}, Country: {order_data.get('Country', 'N/A')}, "
                        f"Original Quantity Ordered: {qty} units, "
                        f"Original Total Net Revenue: ${revenue:,.2f}, "
                        f"Original Total Cost of Goods: ${cost:,.2f}, "
                        f"Original Total Gross Margin: ${margin:,.2f}, "
                        f"Gross Margin %: {margin_pct:.2f}%, "
                        f"Calculated Unit Selling Price: ${unit_price:,.2f} per unit, "
                        f"Calculated Unit Cost: ${unit_cost:,.2f} per unit, "
                        f"Calculated Unit Gross Margin: ${unit_margin:,.2f} per unit."
                    ),
                    "SCORE": 1.0,
                    "METADATA": current_source_metadata(order_id)
                }
                context_chunks.append(order_context_chunk)

        # Stage: Vector retrieval (Unconditional for all chat RAG responses)
        self._emit(cb, "retrieval", "running", "Searching Vector DB...")
        step_vec = {"stage": "retrieval", "status": "running",
                   "message": "Searching Vector DB..."}
        steps.append(step_vec)

        t0 = time.time()
        retrieved = retriever.retrieve(user_message, top_k)
        ctx.retrieval_time_ms = (time.time() - t0) * 1000

        top_score = max((float(c.get("SCORE", 0)) for c in retrieved if isinstance(c.get("SCORE"), (int, float))), default=None)
        score_msg = f" (HANA Cosine Sim: {top_score:.3f})" if top_score is not None else ""
        context_chunks.extend(retrieved)
        step_vec["status"] = "completed"
        step_vec["message"] = f"Retrieved {len(retrieved)} relevant context chunks from SAP HANA Cloud Vector Engine{score_msg}."
        self._emit(cb, "retrieval", "completed", step_vec["message"], details={"engine": "SAP HANA Cloud Vector Engine", "top_score": round(top_score, 3) if top_score is not None else "N/A"})

        # Stage: LLM generation
        self._emit(cb, "explanation", "running", "Preparing answer...")
        step_llm = {"stage": "explanation", "status": "running",
                   "message": "Preparing answer..."}
        steps.append(step_llm)

        t0 = time.time()
        analytics_ctx = self._format_analytics_as_context(plan, analytics_data) if analytics_data else None
        formatted_prompt = prompt_builder.build_prompt(
            user_message, context_chunks, chat_history=self._chat_history, analytics_context=analytics_ctx
        )
        response_text = generator.generate(formatted_prompt)
        ctx.llm_time_ms = (time.time() - t0) * 1000

        step_llm["status"] = "completed"
        step_llm["message"] = "Answer prepared."
        self._emit(cb, "explanation", "completed", "Answer prepared.")

        ctx.finalize("success")
        return {
            "reply": response_text,
            "sources": context_chunks,
            "intent": plan.get("intent", "rag"),
            "type": "chat",
            "status": "success",
            "processing": steps,
            "cosine_score": round(top_score, 3) if top_score is not None else None,
            "data": analytics_data.to_dict() if analytics_data else None,
            "query_plan": plan,
            "records_matched": ctx.records_matched or len(context_chunks),
            "session_id": "default",
        }

    # ── Chat Handler (Streaming) ──────────────────────────────────────────────

    def _handle_chat_stream(self, user_message: str, plan: Dict[str, Any],
                            steps: List, ctx: RequestContext, top_k: int,
                            order_id: str = None,
                            cb: Optional[Callable] = None,
                            stop_event: Optional[Any] = None) -> Dict[str, Any]:
        """
        Streaming variant of _handle_chat.
        Uses generate_stream() and emits token events during LLM generation.
        """
        context_chunks = []
        analytics_data = None

        # If plan indicates structured query is also needed
        if plan.get("requires_structured_query") and plan.get("metric"):
            self._emit(cb, "calculation", "running", "Retrieving data from source...")
            step_calc = {"stage": "calculation", "status": "running",
                        "message": "Retrieving data from source..."}
            steps.append(step_calc)

            t0 = time.time()
            analytics_result = analytics_engine.execute(plan)
            ctx.analytics_time_ms = (time.time() - t0) * 1000

            if analytics_result.success and analytics_result.data:
                analytics_data = analytics_result
                ctx.records_matched = analytics_result.records_matched
                step_calc["status"] = "completed"
                step_calc["message"] = f"Calculated metadata for {analytics_result.records_matched:,} records."
                self._emit(cb, "calculation", "completed", step_calc["message"])
            else:
                step_calc["status"] = "completed"
                step_calc["message"] = "No additional metadata needed for this query."
                self._emit(cb, "calculation", "completed", step_calc["message"])

        # If order_id with analytical context (what-if scenarios)
        if order_id and not self._is_pure_order_lookup(user_message):
            order_data = data_service.get_order_details(order_id)
            if order_data:
                revenue = float(order_data.get('NetRevenueUSD', 0) or 0)
                cost = float(order_data.get('TotalCostUSD', order_data.get('CostUSD', 0)) or 0)
                margin = float(order_data.get('GrossMarginUSD', 0) or 0)
                margin_pct = float(order_data.get('GrossMarginPercent', 0) or 0)
                qty = int(order_data.get('Quantity', 1) or 1)
                unit_price = (revenue / qty) if qty > 0 else 0
                unit_cost = (cost / qty) if qty > 0 else 0
                unit_margin = (margin / qty) if qty > 0 else 0

                order_context_chunk = {
                    "ID": order_id,
                    "TEXT_CHUNK": (
                        f"Exact Order Data for {order_id}: "
                        f"Product Name: {order_data.get('ProductName', 'N/A')}, "
                        f"Category: {order_data.get('Category', 'N/A')}, SubCategory: {order_data.get('SubCategory', order_data.get('Subcategory', 'N/A'))}, "
                        f"Customer: {order_data.get('CustomerName', 'N/A')}, Country: {order_data.get('Country', 'N/A')}, "
                        f"Original Quantity Ordered: {qty} units, "
                        f"Original Total Net Revenue: ${revenue:,.2f}, "
                        f"Original Total Cost of Goods: ${cost:,.2f}, "
                        f"Original Total Gross Margin: ${margin:,.2f}, "
                        f"Gross Margin %: {margin_pct:.2f}%, "
                        f"Calculated Unit Selling Price: ${unit_price:,.2f} per unit, "
                        f"Calculated Unit Cost: ${unit_cost:,.2f} per unit, "
                        f"Calculated Unit Gross Margin: ${unit_margin:,.2f} per unit."
                    ),
                    "SCORE": 1.0,
                    "METADATA": current_source_metadata(order_id)
                }
                context_chunks.append(order_context_chunk)

        # Stage: Vector retrieval
        self._emit(cb, "retrieval", "running", "Searching SAP HANA Cloud Vector DB...")
        step_vec = {"stage": "retrieval", "status": "running",
                   "message": "Searching SAP HANA Cloud Vector DB..."}
        steps.append(step_vec)

        t0 = time.time()
        retrieved = retriever.retrieve(user_message, top_k)
        ctx.retrieval_time_ms = (time.time() - t0) * 1000

        top_score = max((float(c.get("SCORE", 0)) for c in retrieved if isinstance(c.get("SCORE"), (int, float))), default=None)
        score_msg = f" (HANA Cosine Sim: {top_score:.3f})" if top_score is not None else ""
        context_chunks.extend(retrieved)
        step_vec["status"] = "completed"
        step_vec["message"] = f"Retrieved {len(retrieved)} relevant context chunks from SAP HANA Cloud Vector Engine{score_msg}."
        self._emit(cb, "retrieval", "completed", step_vec["message"], details={"engine": "SAP HANA Cloud Vector Engine", "top_score": round(top_score, 3) if top_score is not None else "N/A"})

        # Stage: LLM generation (STREAMING)
        self._emit(cb, "explanation", "running", "Generating answer via NVIDIA NIM...")
        step_llm = {"stage": "explanation", "status": "running",
                   "message": "Generating answer via NVIDIA NIM..."}
        steps.append(step_llm)

        t0 = time.time()
        analytics_ctx = self._format_analytics_as_context(plan, analytics_data) if analytics_data else None
        formatted_prompt = prompt_builder.build_prompt(
            user_message, context_chunks, chat_history=self._chat_history, analytics_context=analytics_ctx
        )

        # Stream tokens and accumulate full response
        full_response_parts = []
        for token in generator.generate_stream(formatted_prompt, stop_event=stop_event):
            full_response_parts.append(token)
            self._emit_token(cb, token)

        response_text = "".join(full_response_parts)
        ctx.llm_time_ms = (time.time() - t0) * 1000

        step_llm["status"] = "completed"
        step_llm["message"] = "Answer prepared."
        self._emit(cb, "explanation", "completed", "Answer prepared.")

        ctx.finalize("success")
        return {
            "reply": response_text,
            "sources": context_chunks,
            "intent": plan.get("intent", "rag"),
            "type": "chat",
            "status": "success",
            "processing": steps,
            "cosine_score": round(top_score, 3) if top_score is not None else None,
            "data": analytics_data.to_dict() if analytics_data else None,
            "query_plan": plan,
            "records_matched": ctx.records_matched or len(context_chunks),
            "session_id": "default",
        }

    # ── Helpers ────────────────────────────────────────────────────────────────

    def _describe_intent(self, plan: Dict[str, Any]) -> str:
        """Generate a user-friendly description of the detected intent."""
        intent = plan.get("intent", "chat")
        metric = plan.get("metric")
        dimension = plan.get("dimension")

        if intent == "graph":
            parts = ["Graph request"]
            if metric:
                parts.append(f"for {metric}")
            if dimension:
                parts.append(f"by {dimension}")
            return " ".join(parts)
        elif intent == "ranking":
            limit = plan.get("limit", 10)
            return f"Ranking: Top {limit} {dimension or 'records'} by {metric or 'value'}"
        elif intent == "analytical":
            agg = plan.get("aggregation", "SUM")
            return f"Analytical: {agg} of {metric or 'data'}" + (f" by {dimension}" if dimension else "")
        elif intent == "comparison":
            return f"Comparison analysis for {metric or 'metrics'}"
        else:
            return "Semantic search and analysis"

    def _describe_filters(self, plan: Dict[str, Any]) -> str:
        """Generate filter description for UI."""
        parts = []
        for f in plan.get("filters", []):
            parts.append(f"{f['column']} {f['operator']} {f['value']}")
        df = plan.get("date_filter")
        if df:
            if df.get("from") == df.get("to"):
                parts.append(f"{df['column']} = {df['from']}")
            else:
                parts.append(f"{df['column']}: {df.get('from')} to {df.get('to')}")
        if parts:
            return "Filters: " + ", ".join(parts)
        return "No filters applied."

    def _format_analytics_as_context(self, plan: Dict[str, Any],
                                     result) -> str:
        """Format analytics results as context for the LLM prompt."""
        metric = plan.get("metric", "value")
        agg = plan.get("aggregation", "SUM")
        dimension = plan.get("dimension")

        if not result.data:
            return "No data available for the requested analysis."

        has_date_filter = bool(plan.get("date_filter") or plan.get("filters"))
        scope_note = "OVERALL DATASET TOTAL ACROSS ALL YEARS (2023, 2024, 2025)" if not has_date_filter else "FILTERED DATASET SCOPE"

        lines = [f"PRE-CALCULATED DATA ({agg} of {metric}) — SCOPE: {scope_note}:"]

        if dimension:
            # Support composite dimensions (e.g. "Year, Quarter" → label col "Year Quarter")
            is_composite = ", " in str(dimension)
            if is_composite:
                label_col = dimension.replace(", ", " ")
            else:
                label_col = dimension

            for row in result.data[:30]:
                # Try composite label first, then individual dimension
                dim_val = row.get(label_col, row.get(dimension, "Unknown"))
                val = row.get(metric, 0)
                fmt = row.get("formatted_value", str(val))
                lines.append(f"  {dim_val}: {fmt}")
        else:
            for row in result.data:
                val = row.get("value", 0)
                fmt = row.get("formatted_value", str(val))
                lines.append(f"  Overall Total {metric} ({agg}): {fmt}")

        lines.append(f"\nTotal records matched: {result.records_matched:,} (100% of dataset)")
        lines.append(f"Total records in dataset: {result.records_total:,}")
        return "\n".join(lines)

    def _generate_analytical_response(self, user_message: str,
                                      plan: Dict[str, Any],
                                      result) -> str:
        """Generate LLM explanation for analytical results."""
        data_context = self._format_analytics_as_context(plan, result)

        prompt = f"""You are an expert enterprise analytics assistant.
The following data has been pre-calculated from the source dataset. Present it clearly and accurately.
DO NOT invent, modify, or recalculate any numbers. The values below are the authoritative source.

{data_context}

User's question: {user_message}

Provide a clear, executive-style response:
- State the answer directly first
- Use the exact numbers from the pre-calculated data
- Format monetary values with $ and commas
- Use markdown tables if presenting grouped data
- Bold key metrics
- Do NOT add data that isn't in the pre-calculated results

Executive Response:"""

        try:
            return generator.generate(prompt)
        except Exception as e:
            logger.error(f"[Pipeline] LLM generation failed: {e}")
            # Fallback: format data directly
            return self._format_data_directly(plan, result)

    def _format_data_directly(self, plan: Dict[str, Any], result) -> str:
        """Format data without LLM as fallback."""
        metric = plan.get("metric", "Value")
        dimension = plan.get("dimension")
        agg = plan.get("aggregation", "SUM")

        # Support composite dimensions
        is_composite = ", " in str(dimension) if dimension else False
        label_col = dimension.replace(", ", " ") if is_composite else dimension

        lines = [f"### {agg.title()} of {metric}"]
        if dimension:
            lines.append(f"\n| {label_col} | {metric} |")
            lines.append("| :--- | ---: |")
            for row in result.data[:30]:
                dim_val = row.get(label_col, row.get(dimension, ""))
                fmt = row.get("formatted_value", "")
                lines.append(f"| {dim_val} | **{fmt}** |")
        else:
            for row in result.data:
                fmt = row.get("formatted_value", str(row.get("value", "")))
                lines.append(f"\n**{agg} of {metric}:** {fmt}")

        lines.append(f"\n*Based on {result.records_matched:,} matching records.*")
        return "\n".join(lines)


rag_pipeline = RAGPipeline()
