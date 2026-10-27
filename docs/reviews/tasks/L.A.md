# L.A — live artifacts requirements traceability

Reviewed main **2837b499de2e64d0012faeb08809299a9f557607**. The PRD's numbered requirements are the row inventory; section 4's complete editor action table and section 5's deck actions are included in R1.15 and R2.3. The PRD's phase table and later decision put decks in phase 2, despite the earlier section 1 table saying phase 3. This audit uses the explicit phase 2 requirements. The original PRD's “nothing here is built yet” is historical.

Statuses: **I** = implementation plus local evidence for the stated portion, not full acceptance; **G** = concrete implementation gap; **E** = external/product acceptance gate; **A** = active LG.5 or LX.5. Multiple statuses mean different parts of one requirement. Evidence below is existing evidence, not a new test run. In particular an aggregate green root run does not prove any phase accepted. Locations are repository-relative. Reviews document the exact commands, SHA and fixture limits; earlier findings there must be read with their later remediation, not as current defects.

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
| R1.9 own blobs and external image fetch | I, G | Schema ownership allowlist and upload endpoint (`routes.ts`, `service.ts` `uploadImage`) prevent hotlinking; L.2 security tests and L.7 production fixture cover ownership. No URL-fetch-and-store insertion path found: schema rejects non-owned URLs and upload accepts file bytes. Implement safe external URL ingestion or explicitly change the PRD; denial alone does not meet its fetch requirement. |
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
| R1.31 three run triggers only | I, E | L.4c durable dispatch and `ask.ts`, L.9 panel; real three-surface agent execution remains open. |
| R1.32 authenticated speaker, where, roster | I, E | L.4c/L.6 trusted envelope tests and L.7 room presence adapter; distinct real members and model execution remain open. |
| R1.33 forged envelope escaped | I | L.6/L.4c envelope and forged-input tests. |
| R1.34 multi-person Slack sender | I, E | L.6 Slack roster/envelope tests; actual multi-person Slack/model acceptance is not recorded. |
| R1.35 thread fold and authors | I, E | `packages/protocol/src/thread.ts`, L.6a tests and L.6 transport integration; real multi-member UI remains open. |
| R1.36 answer, never resolve human thread | I, E | L.4b/L.4c comment authorization and dispatch tests; real agent answer through app remains open. |
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
| R3.8 scoped guest run/tools | A | LG.5 active. LG.4 records guest ask currently refuses; no restricted runtime readiness is claimed. |
| R3.9 daily cap before run | A | LG.5 active; not accepted based on service leaf alone. |
| R3.10 owner/member approvals, no guest answer | A | LG.5 active, including durable runtime/approval continuation and member routing. |
| R3.11 approval for member outbound tools with guest present | A | LG.5 active; integrated behavior not claimed. |
| R3.12 guest views and audit events | I, E | LG.0/LG.3 service and fixture evidence; real deployed provider flow remains. |
| R3.13 LIVE_GUESTS_OFF | I, E | `guest-actions.ts` and guest/room checks, LG.3 fixtures; deployed configuration acceptance remains. |

## Phase 4

| Requirement | Status | Implementation and evidence / remaining boundary |
|---|---|---|
| R4.1 suggestions | A | LX.5 active; neither completion nor direct-edit replacement is claimed. PRD decision for earlier phases says guest runs initially edit directly; phase 4 changes that contract. |
| R4.2 PDF/Word/PPTX exports | I, E | `packages/live-export`, member routes and mounted controls; LX.2 real local Chrome downloads and Office archive tests. Signed app, deployed Browser Run, production quota and target Office fidelity are separate gates. Unsupported mappings are surfaced as warnings. |
| R4.3 page/dashboard element ask | I, E | `/a/$artifactId` mounts `ElementAskViewer`, sandbox bridge `ui/message` and `askElement`; LX.3 mounted browser with real router/service and fixture identities. Signed product/model gate remains. |
| R4.4 mention email | I, E | Document/deck comment composers, `mentions.ts`, `mention-infra.ts` and maintenance outbox; LX.3 captured adapter/browser. Real directory and email delivery remain; bounded at-least-once attempts can duplicate or exhaust. |
| R4.5 deck embeds | I, G, E | LX.4 `2188a62b` integration, sandbox frame, resolver and room validation; local workerd/browser fixtures and bounded recheck. Guest client has no guest-scoped resolver and shows unavailable placeholder (LG.4). Discovery silently truncates at 2,000 (`live-artifacts/service.ts`); exact authorization is separately fixed, but eligible sources beyond the listing are undiscoverable. Full signed/staging and guest acceptance remain. |

## Prioritized remaining work and acceptance

1. **Unassigned implementation: R1.9 external images.** Add an authorized, bounded external-image fetch/store path for document insertion/import and return an artifact-owned URL before it enters the shared schema; exercise actual consumers and preserve the existing no-third-party-render guarantee. The current byte-upload route is not that path.
2. **Unassigned implementation: guest deck embeds.** Define and implement guest-scoped source/content authorization bound to the invited deck, current grant and exact source version/path; connect the guest deck consumer and test revocation. Do not turn guest credentials into member authority. LG.4 explicitly records the unavailable placeholder.
3. **Unassigned implementation: embed discovery.** Paginate or explicitly expose truncation and provide a way to discover all eligible sources; `service.ts` slices at 2,000. LX.4's exact authorization/room recovery fixes do not fix discovery completeness.
4. **Active work:** LG.5 owns R3.8–R3.11; LX.5 owns R4.1. Review their merged integrations separately when available; this audit neither duplicates nor certifies them.
5. **External acceptance:** authorized signing/Clerk setup, distinct real members, real agent and each runtime including approvals, actual mail delivery, staging hibernation/revocation/timing, deployed Browser Run and export quotas, and target Office application checks. Execute the exact scenario gates described in L.7, L.8/L.9, LD.6, LG.4, LX.2 and LX.3. The prior provider-blocked migration security recheck remains recorded in its own review; this audit does not repeat it.

No tests, provider calls, secrets, deployment or environment changes were made for this report. Conclusions are source inspection and the cited existing evidence; fixture successes and older root runs do not establish all-phase acceptance.
