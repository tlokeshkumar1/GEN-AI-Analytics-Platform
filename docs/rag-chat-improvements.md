# RAG chat: dynamic answers and latency fixes

## Transcript problem

The supplied transcript showed a 10.27-second greeting and a 62.05-second answer to `what data i have ?`. The second answer asked the user to supply table names, although the greeting had already listed them. These are end-to-end transcript measurements, not per-stage server timings.

The inventory question entered the generic vector/model path without the dataset catalog as evidence. Greetings also incurred snapshot, semantic and AI setup before reaching their existing static response.

## Current behavior

| Request | Source and execution |
| --- | --- |
| Greeting or available-data question | Current authorized workspace catalog; no snapshot, semantic-model setup, embedding or model request |
| Explicit simple total, average, minimum, maximum or count | Field names and aliases from the current semantic model; validated calculation and direct result formatting |
| Exact record lookup | Actual returned record attributes, without model rewriting, inferred currency symbols or forced rounding |
| Complex calculation or chart | AI may propose a structured plan; the executor validates it and the answer displays its calculated values directly |
| Explanatory question with matching evidence | Retrieved dataset evidence and recent conversation context go to NVIDIA |
| Missing evidence, ambiguous metric or invalid plan | Explicit clarification or an insufficient-evidence response; no unsupported numerical answer |
| Quantity what-if | Declared, unambiguous quantity/revenue/cost measures and Decimal calculations; constant unit economics are stated as an assumption |

Dataset names, measures, groupings, aliases, values and recorded units come from metadata or actual records. Intent routing still uses general language rules for greetings and simple commands; it contains no identifiers for the user's three example tables. Unsupported or ambiguous wording can still need AI planning or clarification.

The old margin and product shortcuts no longer choose arbitrary numeric/categorical columns or an implicit 2024 period. Those requests use the general validated planner. Invalid numerical proposals cannot silently enter explanatory RAG. Requested explicit years and `where` constraints are checked for omission.

Catalog answers report the catalog as their source, without a fabricated cosine score or claim that every dataset is ready. Unknown row counts remain unknown. Catalog-only conversations acquire their dataset context on the first dataset-specific turn.

History and identity remain enforced. The streaming route moves blocking history operations off the event loop, avoids unnecessary history reads for catalog answers, and reuses middleware-verified identity. Ownership/context rejections propagate. Genuine storage failures allocate a new ephemeral ID and do not read/write the submitted session.

## Verification and limits

`backend/tests/test_catalog_chat.py` reproduces both transcript turns through REST and SSE with real local SQL history persistence. It also checks permissions, empty catalogs, context binding, session rejection, storage failure and ASGI body replay. Provider and snapshot calls raise errors if the catalog path attempts them.

`backend/tests/test_dynamic_chat.py` exercises unrelated schemas, approved aliases, exact arithmetic results, unsupported aggregations, missing evidence, dropped years, source-value formatting and declared financial scenarios.

Final offline verification: **220/220 backend tests** and **47/47 frontend tests** pass, including 17 new backend regressions for this follow-up.

Run the offline backend suite with:

```powershell
backend/api/venv/Scripts/python.exe scripts/run_offline_tests.py
```

These checks do not establish production latency or universal natural-language accuracy. Catalog/history/database access, authentication, data quality and external model latency can still affect deployed requests. Ambiguous business definitions need review; the application cannot manufacture certainty from missing data. No deployment was performed.

## Natural conversation refinement

The second supplied transcript showed that the catalog answer was incorrectly included in a greeting, and that retrieved examples were presented like a dataset overview. Greetings now use a separate, streamed model response capped at 48 output tokens, without loading the catalog or sending dataset context. New streamed greetings begin generation before history persistence; existing sessions are still authorized first.

Record explanations now use a concise model response grounded in the actual record. Explanatory and record output is capped at 600 tokens (or a lower configured workspace limit). The prompts request natural answers and relevant Markdown tables, without mandatory executive headings or repeated recommendations. Retrieved rows must be described as examples, never as a complete dataset or its total count. Explicitly named datasets narrow vector retrieval after authorization. Numerical totals continue to use the validated executor rather than sampled vector chunks.

The chat screen retains history, charts, processing details, source inspection, export and message actions, with a warm background, violet accents, softer composer and styled tables. Fabricated document counts, deployment-region labels and vector-version/synchronization claims have been removed.
