---
id: LX.0
title: Document and deck export format engines
milestone: L
size: L
status: review
depends_on: [L.2, LD.0, LD.2]
branch: t3/complete-lx0-export-engines
lane: exports
executor: codex
---

## Scope and check

Implement reusable export engines for phase4 R4.2: document DOCX, deck PPTX using PptxGenJS, and safe static print HTML for document/deck PDF rendering. Consume accepted shared schemas/scene and verified binary assets through typed mandatory ports. Actual Browser Run PDF, authorized download endpoints and product UI remain phase4 integration. Validate generated ZIP/XML and representative visual output/print rendering with hostile input tests. No changes to active server/client composition or shared core.

## Log

- 2026-10-27: Started independent format-engine work to parallelize later phase while document wiring and deck UI finish. No route/release enablement; commit major tasks and verify browser/Worker runtime suitability.

- 2026-10-27: Engines merged; independent findings remediated in db291d50. Fourteen focused tests and root check/test pass; production PDF/download/UI integration remains separate.
