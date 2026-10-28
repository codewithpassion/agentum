# LR.3 independent assurance

Two independent reviews ran at main 6fe2bf68. Each ran twice (the first pair of reviewers was cut off before it reported, so both subjects were reviewed by fresh reviewers; reports agreed on every material point). No reviewer read prior review conclusions before forming findings.

## Review A: Yjs deck position-migration remediation (1f30cc5f, e2183512)

Verdict: not clean, open design findings. The migration-root grammar itself held. Probes covered hidden, deleted and overwritten payloads inside the roots, cross-fragment ancestry, prefix lookalike roots, nested shared types, and byte-identical authority state after rejection. About 6,800 randomised real Tiptap structural edits (list, split, sink, lift, tables, undo, two collaborators) were admitted with no false rejections.

| # | Severity | Finding | Status |
|---|---|---|---|
| A1 | must-fix (design) | Lifetime budgets (10,000 records, 100,000 seen/transfer entries, 2M positions, migrations.ts:160 and :244) count the whole retained history. A 10k-character text toggled about 200 times, or one 570 KB editor update adding deleted client ids, makes every later structural edit fail with invalid_deck_position_migration. `restore()` (index.ts:1647) does not clear migration roots, so there is no recovery. | Open |
| A2 | must-fix (design) | `doc.gc = false` (index.ts:898) retains deleted and overwritten payloads under meta, sections and slides, and nothing validates them. An editor can add deleted bytes up to the 16 MB scene limit, after which edits and restore fail ("compact checkpoint required"). No compaction path exists. | Open |
| A3 | should-fix | Full-history revalidation on every update, three times per commit in `commitDeck`. A crafted 1 MB update makes each validation about 0.75 s. Fixed by the same incremental validation or compaction as A1/A2. | Open |

These are availability limits an authorised deck editor can hit on their own deck. They are not an authorisation, confidentiality or cross-tenant bypass. The fix needs a design decision (incremental validation of only new records, plus a compaction that rebuilds the doc from live state while keeping migration-referenced ancestry), so it is a new task, not a Haiku unit.

Nits left: target.type is checked only against the first destination item and source type is not checked (migrations.ts:197); applyUpdate persists and broadcasts the original bytes, so trailing bytes and a `__proto__` primitive in a record survive until compaction (index.ts:1595); `reject()` carries no reason (migrations.ts:18); `target.boundary` and `source.boundary` are not cross-checked; test gaps for the caps, `within` depth, cross-fragment spans, `restore` with hostile roots, and gc:true peers; the "overwritten" test only covers set-then-delete.

## Review B: guest addressed-comment and isolated runtime tranche (b87b4309, 5f0fd129, 988fe0db, 80b7c8ef, 0032_lovely_lake.sql)

Round 1 verdict: two fresh reviewers disagreed (one not clean, one clean). Triage took the stricter reading.

| # | Severity | Finding | Resolution |
|---|---|---|---|
| B1 | must-fix | Guest-started anchored thread stored no quote (scoped-comments.ts, guest-server.ts). | Fixed in 9f5b3299, test added. |
| B2 | must-fix | Thread returned to the model included soft-deleted comments, unordered and unlimited (scoped-comments.ts result()). Latent, nothing sets deleted_at yet. | Fixed in 9f5b3299, test added. |

Round 2 (re-review of 9f5b3299): clean.

Held up: migration 0032 is valid D1 SQL and matches the drizzle schema and meta chain; revocation and expiry between access() and commit leave no rows; concurrent identical callIds and requestIds produce one effect; changed payloads conflict; machine, managed and ordinary comment paths refuse scoped runs; inference gets no agent instructions or tools.

Nits left: `answered: true` is allowed on any agent-addressed thread in the artifact, including other guests' (scope to the run's bound thread); thread cap hits surface as raw NOT NULL errors (scoped-comments.ts, addressed-comment.ts:96); whitespace-only middle chunk in `commentChunks` throws ZodError after an earlier chunk posted; body limit mismatch between 4096 bytes and the MCP/HTTP schemas; hard-coded 100/1000 caps; services built ad hoc instead of in `composeWith`; `complete` posts answers and completes the run as two writes; non-JSON model output fails the run after 5 retries; retry of an addressed comment re-runs the agent-readiness check; stale pending-comment in sessionStorage after unmount; guest-execution.test.ts uses a check-count floor; no direct unit tests beyond the two added; quote has no byte cap; replay `comment` is not filtered by deletedAt; guest runs on machine and managed agents take the agent's single run slot.

## Ideas beyond scope

A compaction path for live-deck (rebuild from live state, keep migration-referenced ancestry) would close A1 to A3. Port the reviewers' adversarial probes for B into live-guests tests.

## Steps for Dom

Decide whether A1 to A3 get a new task. No accounts or dashboards are needed. The guest-run provider-side acceptance in staging remains as listed in L.A.md.
