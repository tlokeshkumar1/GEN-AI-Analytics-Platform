# Enterprise readiness remediation plan

Audited commit: `e2aaca9b651f8617c875400da7a90cef2a60fef6`, 23 November 2026. Ownership below is proposed by responsibility; no team assignments or external tickets were created. Findings and evidence: [consolidated report](docs/audits/ENTERPRISE_READINESS_AUDIT.md).

| Priority | Findings | Proposed owner | Concrete acceptance criteria |
|---|---|---|---|
| P0 | F01: approval policy | Backend / product governance | Enterprise configuration rejects proposed and rejected semantics; explicit authorized review required before execution/publication; auto-approval is a documented opt-in. Strict and permissive modes tested separately. |
| P0 | F02: dataset chat access | Security / backend | A Member with no dataset grants cannot retrieve its records, vectors, schema or computed data via chat, graph, catalog or cross-table selection. Workspace sharing is an explicit grant/policy rather than a hidden exception. Cross-tenant tests remain enforced. |
| P0 | F03: dynamic joins | Analytics / data engineering | Both join paths validate cardinality, null keys, ambiguity and amplification against independently calculated expected totals. Many-to-many expansion requires an explicit supported model; otherwise rejected. |
| P0 | F05: endpoint trust | Security / connectors | Production requires explicit hosts; IPv4/IPv6 loopback, link-local, private/mapped addresses and redirects/rebinding are defended at connect time. Test legitimate private enterprise endpoints through explicit administrative policy. No unapproved external probes. |
| P0 | F09: dependencies | Security / build engineering | Triage every critical/high advisory for runtime/build reachability; upgrade compatible patched versions; update locks and Python constraints; security scans and application regressions pass or formally documented risk acceptance is reviewed. Scanner counts are deduplicated. |
| P1 | F04: connection discard | Backend / SRE | A single pool discard API closes failed connections and releases exactly one permit. Fault tests include cursor creation/execution/close, rollback failure, stale connection and repeated reconnect. Zero capacity loss after failures. |
| P1 | F07: exact output decimals | Analytics / frontend | Large fractional values survive API serialization, frontend rendering and export without cent loss. Use a documented exact representation; test independent decimal expectations. |
| P1 | F08/F14: uploads and exports | Data engineering / security | Neutralize spreadsheet formulas at the actual export sink; assert XLSX cell types. All upload/discover/preview routes share byte/decompression limits and reject malformed/oversized archives without partial publication. |
| P1 | F06/F15: runtime secrets and dev auth | Security / platform | Development bypass needs explicit opt-in and cannot operate in deployed modes. Require stable managed encryption keys; verify API/worker replicas, key rotation, restart, revocation and redacted failures. |
| P1 | F10: report integrity | Frontend / analytics | Remove unsupported compliance assertions. Reports derive from authorized dataset/version/semantic revision, include provenance and approved calculation results, and expose loading/error/recovery states. |
| P1 | F11/F17: deployment and readiness | Platform / SRE | Track sanitized MTA manifest. Build from a clean checkout; validate HDI/migrations in disposable schema; implement dependency readiness, graceful shutdown/drain, quotas and bounded retries; test unavailable-provider startup. |
| P1 | F12/F13 | Frontend / backend | All eight existing frontend regressions pass with meaningful assertions. Retry recommendation failure preserves intended 503 rather than undefined-logger failure; add a failure-path test. |
| P1 | F16: historical joins | Analytics / backend | Persist and authorize versions/revisions for both join sides. A historical query returns identical results after either dataset updates; no silent latest-version substitution. |
| P2 | F18, cache/ownership gaps | Architecture / maintainers | Add repository-owned lint/tool configuration and module ownership, resolve lint defects, consolidate reachable duplicate code, document deferred import cycles and cache invalidation across replicas. |
| P2 | Semantic confidence / RAG quality | AI engineering / domain reviewers | Representative samples include late/sparse categories; calibrated confidence and review thresholds are evaluated on domain-blind fixtures. Score answer correctness, citation precision and failure categories using actual configured providers. |
| P3 | Browser, load and retention evidence | QA / SRE | Complete all 12 screens × five states, accessibility/responsive/browser auth and chart checks. Run sustained authenticated-user load (1/10/25/50/100), concurrent ingest/chat/dashboard tests, memory/CPU/stream/embedding measurements, and retention/tombstone recovery exercises. |
| P3 | Reproducibility | Build engineering | Locked Python/tool dependencies, pinned workflow actions, reproducible clean artifacts and recurring advisory/secret scanning with a documented exception lifecycle. |

Release sequence:

1. Resolve P0 findings and exact analytics/pool failure paths before broad service load tests.
2. Establish an explicitly approved disposable HANA schema and protected test environments for XSUAA, AI and each connector. Run real integrations; retain IDs/plans/transactions without credentials or sensitive records.
3. Make required CI green, complete browser coverage and establish SLOs before sustained concurrency testing.
4. Recalculate the audit score from new evidence. Release only after mandatory security/integration/deployment/recovery gates pass; score alone is insufficient.

No production fixes, dependency upgrades, deployment, merge, remote workflow execution or external messaging were performed during this audit.
