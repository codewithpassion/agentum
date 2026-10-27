# L.A — live artifacts requirements traceability

Reviewed main **4700ace928fdb86bd5f6ca2eab05d2ec5632374c** (merge containing LG.6 `72fabfbe`, LG.5 follow-ups through `8d3ecb03`, LX.5 and `bc6480af`). The PRD's numbered requirements are the row inventory; section 4's complete editor action table and section 5's deck actions are included in R1.15 and R2.3. The PRD's phase table and later decision put decks in phase 2, despite the earlier section 1 table saying phase 3. This audit uses the explicit phase 2 requirements. The original PRD's “nothing here is built yet” is historical.

Statuses: **I** = implementation plus local evidence for the stated portion, not full acceptance; **G** = concrete implementation gap; **E** = external/product acceptance gate; **C** = concurrent LG.6 independent review remains open. Multiple statuses mean different parts of one requirement. Evidence below is existing evidence, not a new test run. In particular an aggregate green root run does not prove any phase accepted. Locations are repository-relative. Reviews document the exact commands, SHA and fixture limits; earlier findings there must be read with their later remediation, not as current defects.

Production integration inspected: `apps/web/src/routes/a.$artifactId.tsx` mounts `LiveDocumentPage` and `LiveDeckPage`; `apps/web/src/server/trpc/router.ts` mounts live services composed in `apps/web/src/server/compose.ts`; `apps/web/src/server/live-artifacts/routes.ts`, `production-room.ts`, `artifact-room.ts` and `maintenance.ts` connect routes, room and recovery. Guest routing/client and phase 4 consumers are noted below. Local fixture identities and captured provider adapters do not establish real Clerk, signing, mail delivery or staging.

## Phase 1

| Requirement | Status | Implementation and evidence / remaining boundary |
|---|---|---|
| R1.1 create/open document | I, E | `live-artifacts/service.ts`, `/a/$artifactId` and document page; L.7 production workerd creation and L.8 client fixture. Signed full-app creation remains open. |
| R1.2 simultaneous two browsers + agent | I, E | L.2 concurrency and L.8/L.9 two-context room fixtures; L.7 MCP round trip. The specified simultaneous three-party real-agent product scenario remains unverified. |
| R1.3 checkpoints, contents, deadlines | I, E | `artifact-room.ts`, `production-room.ts`, service checkpoint and maintenance; L.3 and L.7 workerd fixtures, including recovery and atomic provenance followup. Deployed timing remains unverified. |
| R1.4 cards, thumbnails, read, history, download, link shares | I, E | Artifact service and live checkpoint consumers, document page and Markdown route; L.7 publication/fixture, L.8 and L.9. Actual signed product round trips and all downstream consumers on latest checkpoint need acceptance. |
| R1.5 live restore | I, E | Room restore and service/version wiring; L.7 and L.8 room fixtures. Signed app restore and peer visibility remain open. |
| R1.6 size, chunks and limit | I, E | L.3 room storage tests and L.7 large-document fixture; staging limits/performance not established. |
| R1.7 make editable | I, E | `live-artifacts` conversion and artifact UI; L.4a service evidence. Signed app flow remains open. |
| R1.8 shared schema and hostile input | I, E | `packages/live-doc/src/schema.ts`, room candidate validation and `security.test.ts`; L.2/L.3/L.7. Fuzz/local hostile corpus is not a deployed browser signoff. |
| R1.9 own blobs and external image fetch | I, E | Mounted URL insertion in `use-document-editor.ts` and `packages/services/src/live-artifacts/external-image.ts`, composed with `apps/web/src/server/live-artifacts/public-image-fetch.ts`; L.GAPS records broader public HTTPS and peer-browser owned-blob checks. Deployed public egress, TLS, redirects and upstream behavior remain gates; bulk Markdown image import is not established. |
| R1.10 ticket single use/age/artifact | I, E | Room admission and ticket production adapter; L.3/L.7 actual workerd replay tests; deployed gate remains. |
| R1.11 viewer/commenter no updates | I, E | Room role checks, L.3 and L.8 real-room fixtures; signed product gate. |
| R1.12 access loss/delete close within 5s | I, E | Room authorization refresh and durable invalidation/maintenance; L.7 fixture; real Clerk and staging timing remain. |
| R1.13 15-minute expiry/renewal | I, E | Room controls and credential refresh; L.3/L.7 fixtures; deployed timing remains. |
| R1.14 hibernation local and staging | I, E | `docs/v3/live-spike.md`, L.3 workerd evidence; staging hibernation explicitly remains L.10 gate. |
| R1.15 all section 4 actions live | I, E | `components/live-artifacts` editor and L.8a action/browser checks; L.8 two-context room fixture. The full action-by-action second-browser signed app check is not recorded. |
| R1.16 own undo/redo | I, E | L.8 real-room two-context checks; signed app acceptance remains. |
| R1.17 390×844 and 40px controls | I, E | L.8a reports 138 controls measured and L.8/L.9 room fixtures at phone size. Full authenticated editor plus comments/panel remains unverified. |
| R1.18 authoritative avatars | I, E | Room awareness identity rewrite and document UI; L.3/L.8 fixtures. Distinct real Clerk identities remain open. |
| R1.19 caret/selection within 500ms | I, E | Room and L.8 presence fixtures; specified latency under same-network product conditions is not certified. |
| R1.20 follow avatar | I, E | Editor presence UI and L.8a browser evidence; full app remains open. |
| R1.21 agent presence/status/clear | I, E | MCP/room presence heartbeat and cleanup in L.7; L.3 fixtures. Actual agent across browsers and five-second measurement remain open. |
| R1.22 four tools on all runtimes | I, E | `packages/mcp/src/tools/live.ts`, production MCP adapters and L.5/L.7 tests. L.7 does not establish actual cloud isolate, Linux VM, Managed and machine end-to-end for each tool. |
| R1.23 outline, hashes, revision, sinceRev | I | `packages/live-doc` and L.2/L.5 focused tests, L.7 MCP fixture. |
| R1.24 guarded replace/delete | I | L.2 guard tests and L.7 real production adapter fixture. |
| R1.25 concurrent insert and typing | I, E | L.2 simulated concurrency; the actual person/agent scenario remains a product acceptance gate. |
| R1.26 pending intent/fill deleted | I, E | L.2 operations and L.8 editor presentation; real agent/browser flow remains open. |
| R1.27 dry run | I | L.5 MCP tool tests cover skipped messages/no writes. |
| R1.28 ask-before all runtimes | I, E | Tool registration and approval plumbing in L.5/L.7; actual approval pause on every runtime remains explicitly unverified in L.7. |
| R1.29 agent history/revert preserving human changes | I, E | Room origin/revert and `changes.ts`; L.7 production fixture and L.9 panel tests. Actual agent change/revert through signed app remains open. |
| R1.30 shared thread/authors | I, E | `live-artifacts/ask.ts`, session services and L.6a/L.9; real distinct-member live transcript remains open. |
| R1.31 three run triggers only | I, G, E, C | Member composer, selection and addressed-comment dispatch in `collaboration-panel.tsx` and `live-artifacts/ask.ts`; LG.6 mounts guest thread/selection in `components/guests/viewer.tsx`. Guest `comments.tsx` sends only body and anchor/threadId and has no address-to-agent action. Implement that trigger through scoped execution; verify all three surfaces and no others with real runs. |
| R1.32 authenticated speaker, where, roster | I, E | L.4c/L.6 trusted envelope tests and L.7 room presence adapter; distinct real members and model execution remain open. |
| R1.33 forged envelope escaped | I | L.6/L.4c envelope and forged-input tests. |
| R1.34 multi-person Slack sender | I, E | L.6 Slack roster/envelope tests; actual multi-person Slack/model acceptance is not recorded. |
| R1.35 thread fold and authors | I, E | `packages/protocol/src/thread.ts`, L.6a tests and L.6 transport integration; real multi-member UI remains open. |
| R1.36 answer, never resolve human thread | I, G, E | Member comment dispatch and authorization in L.4b/L.4c. Guest comment UI has no addressed trigger and `apps/web/src/server/guest-run-core.ts` excludes `document_comment`; the commenter role is promised agent answers and comments. Complete the scoped guest comment/answer path and verify no human thread is resolved. |
| R1.37 anchored comments | I, E | Relative anchors, `comments.ts`, L.4b and L.9 tests; signed multi-user comment, detach and resolve flow remains open. |

## Phase 2

| Requirement | Status | Implementation and evidence / remaining boundary |
|---|---|---|
| R2.1 create/open deck | I, E | `/a/$artifactId` mounts `LiveDeckPage`; LD.5 server and LD.6 actual-room fixture. Signed app remains open. |
| R2.2 concurrent properties and slide move | I, E | `packages/live-deck`, LD.0 core and LD.6 two-context real-room tests; exact simultaneous same-slide move in signed app remains unverified. |
| R2.3 all section 5 actions live | I, E | `components/live-decks/deck-editor.tsx`, LD.3 action fixture and LD.6 real-room browser; complete action-by-action signed peer acceptance remains open. |
| R2.4 deck read/write guarded keys | I, E | LD.4 tools, LD.5 production room/adapter fixture; actual runtime/agent product path remains open. |
| R2.5 constrained HTML refusal with path | I | `packages/live-deck` codec and LD.2/LD.4 focused tests; production admission in LD.5. |
| R2.6 transitions, builds, present to everyone | I, E | `presentation.tsx`, presenter lease in room; LD.3 and LD.6 actual-room fixtures. Full product/staging acceptance remains. |
| R2.7 pointers, outlines, strip avatars, hide | I, E | LD.3 UI and LD.6 trusted awareness real-room fixture; signed distinct participants remain open. |
| R2.8 deck where | I, E | LD.5 authoritative presence/ask adapter and LD.6 sender echo; real model turn remains open. |

## Phase 3

| Requirement | Status | Implementation and evidence / remaining boundary |
|---|---|---|
| R3.1 invite member/guest, role/expiry | I, E | `packages/services/src/live-guests`, member router and LG.0/LG.4; real Clerk directory acceptance remains. |
| R3.2 invite EMAIL delivery | I, E | Guest email adapter and captured transport in LG.3/LG.4; actual delivery remains external. |
| R3.3 GET no send, explicit action | I, E | Guest landing/routes; LG.4 production-bundle browser matrix; real mail acceptance remains. |
| R3.4 code, expiry, attempts, hashes, rate limits | I, E | LG.0 guest auth service tests; actual provider/environment acceptance remains. |
| R3.5 secure cookie and landing | I, E | LG.3 guest routes and LG.4 browser fixture; real signed product remains. |
| R3.6 scoped routes and type separation | I, E | Guest routes/room and negative type test in L.6; LG.3/LG.4 fixture checks. Real app and Clerk acceptance remain. |
| R3.7 revoke/expiry/switch and five-second close | I, E | LG.3 reauthorization/room fixtures and LG.4 downgrade/revocation browser; deployed timing remains. |
| R3.8 scoped guest run/tools | I, G, E, C | `viewer.tsx` mounts `GuestAsk`; `guest-run-core.ts`, `mcp/guest-server.ts` and LG.5/LG.6 exercise dedicated cloud scoped runs with captured model. Guest native/machine/managed paths are refused, and `document_comment` is excluded despite the PRD guest commenter contract. Implement missing combinations and comment capability or obtain an explicit PRD decision; no such reduction is accepted here. Real provider and concurrent LG.6 review remain open. |
| R3.9 daily cap before run | I, E, C | LG.5 transactional admission and LG.6 mounted execution fixture cover cap and retry; deployed D1 concurrency and concurrent LG.6 review remain. |
| R3.10 owner/member approvals, no guest answer | I, E, C | LG.5 durable `GuestRun`, Needs-you and member continuation; LG.6 mounted captured-model browser verifies wait/resume and no guest answer. Real signed members, restart and staging remain gates; concurrent LG.6 review remains open. |
| R3.11 approval for member outbound tools with guest present | I, E | LG.5 and subsequent `a69fe604`/`8d3ecb03` effect-bound and refreshed retry rechecks cover local approval paths. Verify actual provider effects, guest joining during calls and all runtime paths in authorized staging. |
| R3.12 guest views and audit events | I, E | LG.0/LG.3 service and fixture evidence; real deployed provider flow remains. |
| R3.13 LIVE_GUESTS_OFF | I, E | `guest-actions.ts` and guest/room checks, LG.3 fixtures; deployed configuration acceptance remains. |

## Phase 4

| Requirement | Status | Implementation and evidence / remaining boundary |
|---|---|---|
| R4.1 suggestions | I, E, C | `suggestions.tsx` is mounted by document and deck collaboration panels and guest viewer; LX.5 and LG.6 record room persistence, individual decisions and guest execution fixture. Signed multi-user, actual provider and concurrent LG.6 review remain. |
| R4.2 PDF/Word/PPTX exports | I, E | `packages/live-export`, member routes and mounted controls; LX.2 real local Chrome downloads and Office archive tests. Signed app, deployed Browser Run, production quota and target Office fidelity are separate gates. Unsupported mappings are surfaced as warnings. |
| R4.3 page/dashboard element ask | I, E | `/a/$artifactId` mounts `ElementAskViewer`, sandbox bridge `ui/message` and `askElement`; LX.3 mounted browser with real router/service and fixture identities. Signed product/model gate remains. |
| R4.4 mention email | I, E | Document/deck comment composers, `mentions.ts`, `mention-infra.ts` and maintenance outbox; LX.3 captured adapter/browser. Real directory and email delivery remain; bounded at-least-once attempts can duplicate or exhaust. |
| R4.5 deck embeds | I, E | LX.4 and L.GAPS trace member paginated discovery and guest exact-source resolver through mounted sandbox frame; production room and 62-scenario guest browser fixture cover local integration and revocation. Signed users, staging and actual content/provider acceptance remain. |

## Remaining implementation and acceptance

- **Unassigned product work:** guest addressed comments and agent comment/answer capability (R1.31, R1.36, R3.8; section 9 commenter role). The mounted guest form and restricted tool list are concrete missing consumers, not merely missing tests. Preserve current grant, role and durable/idempotent execution rules.
- **Runtime coverage:** LG.5 supports dedicated cloud inference only; readiness explicitly refuses native, machine and managed guest execution. The PRD describes an agent on any runtime and scoped guest runs without a runtime exception. Implement the missing combinations or seek a product decision; do not silently treat refusal as completion. R1.22 and R1.28 separately require all four member runtimes.
- **Action inventory:** R1.15 and R2.3 require every item in PRD sections 4 and 5 to propagate to a second browser. Existing focused fixtures exercise subsets, including paste and drag plumbing, but do not establish the complete action-by-action product matrix. Inventory each actual mounted control and both document/deck peer outcomes; any absent or nonfunctional action discovered is product work, not an acceptance waiver. R1.9 bulk Markdown image handling is likewise not established; determine whether an external URL entering at import is fetched and stored under the stated insertion contract.
- **Concurrent LG.6 review:** LG.6 reports local mounted execution, but its independent concurrent review is not represented by this audit. Do not infer its outcome from implementation evidence. LG.5's separate connector rechecks and LX.5's bounded review do not replace it.

## Release acceptance checklist

These are future authorized gates, not actions performed by this audit. Record exact environment, version, identities, result and timing for each.

1. Configure authorized staging with real Clerk signing and two distinct workspace members, an owner/admin, guest identities, signing key and public base URL; provision the actual D1, R2, room/GuestRun Durable Objects, LOADER, SessionStream, EMAIL and Browser Run bindings and applicable migrations. Verify permissions and production-equivalent public-only outbound configuration. No credential values belong in the report.
2. With a real configured model/provider key, run document and deck creation, all three member triggers, trusted speaker/selection/roster and Slack multi-person identity; simultaneously edit from two signed browsers and a real agent. Exercise each document tool and ask-before approval on cloud isolate, Linux VM, Managed and machine, including pause/resume and later human edits/revert. Test guest runtime combinations after product gaps are resolved.
3. Execute every section 4 and 5 action with a second signed browser at desktop and 390×844; verify 40px controls, presence identity, caret latency, follow, comments/anchors, restore, deck properties, presentation transitions/builds and pointer behavior. Verify latest checkpoint in cards, thumbnails, read, history, download and link shares; test 5 MB and 8 MB boundaries and checkpoint deadlines.
4. Deliver real invitation, one-time code and mention mail via EMAIL to controlled addresses. Verify member/guest directory resolution, scanner GET, expiry/attempts/rate limits, cookie isolation, role changes, audit events, daily cap and owner/member approvals; exercise guest document and deck thread, selection and addressed-comment paths and all scoped-tool/foreign-artifact refusals. Test revocation, expiry, workspace switch and `LIVE_GUESTS_OFF` against open sockets and requests, measuring five seconds.
5. On staging observe idle hibernation with open sockets and constructor restart; test recovery, restart/approval continuation, checkpoint/last-leave timing, member access loss and 15-minute connection expiry/renewal. Exercise concurrent D1 admission and effect approvals, including connector refresh, guest arrival and controlled external effects.
6. Test real public HTTPS image sources and redirects through deployed LOADER/egress, confirm owned blobs and no third-party browser requests; exercise member discovery beyond a page and guest embed content/subresources and revocation. Verify deployed sandbox behavior and source eligibility.
7. Download PDF, Word and PPTX using deployed Browser Run and real quotas; inspect fidelity and warnings in target Office applications. Exercise page/dashboard selection through the sandbox bridge with an actual model, and review individual document/deck suggestions with distinct signed participants.

## Independent review limits

The retained migration provider-blocked review in `docs/reviews/tasks/LD.2.md` remains unresolved: the independent remediation approval was not obtained. This audit neither repeats nor rephrases that probe. Existing LD.6 browser and focused tests do not close it. No tests, provider calls, secrets, deployment or environment changes were made for this audit. Existing review evidence is attributed to its recorded SHA and fixtures; it is not a fresh run or all-phase acceptance. The local source inspection above is not a security review.
