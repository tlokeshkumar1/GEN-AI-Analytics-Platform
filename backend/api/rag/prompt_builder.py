from typing import List, Dict, Any, Optional
import json

class RAGPromptBuilder:
    def build_prompt(
        self,
        user_message: str,
        context_chunks: List[Dict[str, Any]],
        chat_history: Optional[List[Dict[str, str]]] = None,
        analytics_context: Optional[str] = None
    ) -> str:
        formatted_chunks = []

        for c in context_chunks[:5]:
            text = c.get('TEXT_CHUNK', '')
            # Cap chunk length to prevent token explosion
            if len(text) > 800:
                text = text[:797] + "..."
            metadata_raw = c.get('METADATA')
            meta_str = ""
            if metadata_raw:
                try:
                    meta = json.loads(metadata_raw) if isinstance(metadata_raw, str) else metadata_raw
                    source = meta.get('source', '')
                    sheet = meta.get('sheet', '')
                    if source or sheet:
                        meta_str = f" [Source: {source or 'N/A'}]"
                except Exception:
                    pass
            formatted_chunks.append(f"-{meta_str} {text}")

        context_str = "\n".join(formatted_chunks) if formatted_chunks else "No retrieved context chunks available."

        # Format conversation history
        history_str = ""
        if chat_history:
            history_lines = []
            for turn in chat_history[-3:]:  # Keep last 3 turns max for context
                role = turn.get("role", "user").capitalize()
                content = turn.get("content", "")
                if len(content) > 300:
                    content = content[:297] + "..."
                history_lines.append(f"{role}: {content}")
            if history_lines:
                history_str = "\n".join(history_lines)

        history_section = ""
        if history_str:
            history_section = f"\nCONVERSATION HISTORY:\n{history_str}\n"

        analytics_section = ""
        if analytics_context:
            analytics_section = f"""
AUTHORITATIVE PRE-CALCULATED METRICS (Calculated deterministically from enterprise database):
{analytics_context}
Use these authoritative calculations directly as the foundation of your response.
Do NOT re-calculate or alter these numbers.
"""

        prompt = f"""You are an executive enterprise analytics AI and RAG assistant.
Your goal is to answer the user query with 100% factual grounding and high clarity.

CRITICAL INSTRUCTIONS:
1. Strict Grounding: Use the pre-calculated metrics and retrieved context below. Never invent, extrapolate, or hallucinate figures.
2. Multi-Year Totals: Summarize figures across all relevant years (e.g. 2023, 2024, 2025) unless a specific year is requested.
3. Presentation:
   - Provide a direct executive summary first.
   - Use bold section headers (e.g. ### Key Insights, ### Performance Breakdown).
   - Use Markdown tables for category breakdowns or multi-year comparative figures.
   - Bold key metrics and monetary figures (e.g. **$14.2M**, **+18.4%**).
4. If the provided data does not contain the answer, state that information is unavailable in the database.
{analytics_section}
RETRIEVED CONTEXT:
{context_str}
{history_section}
USER QUERY:
{user_message}

Executive Response:
"""
        return prompt

prompt_builder = RAGPromptBuilder()
