---
id: LD.0
title: Deck scene model and constrained HTML boundary
milestone: L
size: M
status: review
depends_on: [L.1]
branch: t3/live-deck-core-1
lane: deck
executor: codex
---

## Scope and check

Implement independent packages/live-deck core for phase 2: validated Yjs scene, fractional ordering, per-property merge, strict constrained HTML parser/serializer and revision-guarded agent diff. Follow PRD section 5 and R2.2/R2.4/R2.5. No UI/room/service wiring. Text-schema integration with L.2 and runtime connection remain phase 2 gates.

Use meaningful tests and required root checks. Commit substantial tasks. Follow docs/v3/live-artifacts-prd.md. Keep changes isolated from active service, document engine and MCP lanes. Do not mark the parent phase complete based on this leaf task.

## Log

- 2026-10-27: Dispatched additional independent worktree at user request to increase parallel throughput.

- 2026-10-27: Terra prototype b5b0b2cc left unmerged: known revision ABA bug, incomplete trust/operations/limits and 46 lint failures. Sol assigned completion on its isolated branch; prototype is not phase acceptance.

- 2026-10-27: Completed core 10dbdf15 merged at d998ce00; 23 focused tests and root checks passed on implementation branch. Independent review pending; codec and room/editor integration remain separate gates.
