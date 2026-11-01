---
id: AA.15
title: "Gate 2: card text is peer text, the revoke sweep stops scanning all runs, spec lines"
milestone: AA
size: S
status: done
depends_on: [AA.14]
branch: task/AA.15-card-text-and-sweep
lane: services
executor: claude
---

Spec: `docs/v3/agent-connections.md`. Findings: `docs/reviews/AA-2.md`, sections M1 and "What Dom should know", and findings N2, N5, N7, N8 and N9.

## Scope
- M1, recommended option, decided by the controller for Dom on 2 November 2026: `list_agents` returns a peer's description inside the peer envelope with `from.kind` peer, for every run. Correct the "it can only narrow access" comment on `refreshCard`, and add a line to the spec's "What the agent sees" saying card text is peer text. A changed description must not reach a person's view unlabelled either: the page shows it as text from the peer.
- N5: the sweep's chain query must not scan all of `runs` every minute. Use a partial index on live statuses, in one generated migration including `migrations/meta/`, and skip the query entirely on a tick when no connection in the database has ended since the last check, if that's simple. It must not recreate `events`.
- N8: `outbound.listPeers` returns nothing for a run of a managed agent.
- N7: `requests.answer` refuses `always_allow` on a peer-rooted run on the server, so `desk.decide` can't write that rule, and `card-view.tsx` doesn't offer "Always send" before the request loads.
- N2 and N6: spec lines. The 1 hour limit is per request, so the turn limit is the real bound on how long one peer message can hold an agent: about 100 hours at the default. A question in a wake or hand-off lasts 1 hour too. An `auto` peer belongs on an agent that does nothing else.
- N9: the policies panel and the spec's `hourly_limit` row say exactly what counts.

## Check
The check under M1 in `docs/reviews/AA-2.md`. A test that the sweep's query uses the new index, via `EXPLAIN QUERY PLAN` on `bun:sqlite`, and a test for each of N8 and N7. The migration applies on `migrated()`, and the `events` triggers survive it. `bun run check && bun run test && bun run build` pass. The workerd `guest execution` and `ArtifactRoom` tests and the Chrome print test are known load flakes; if one is the only failure, run it alone and record that.

## Log
- 2026-11-02: created from gate 2. Dispatched. This is the last AA task from the gates: gate 2 was the second round, so anything still open afterwards stays recorded in the review file.
- 2026-11-02: merged, review clean. Migration 0039 adds the partial index. The optional sweep skip was left out because a revoke relies on the sweep to finish its work.
- 2026-11-02: production deployed at Dom's request: Worker version f885d00e, previous version 2f25ccf1.
