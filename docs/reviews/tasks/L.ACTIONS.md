# L.ACTIONS — mounted document/deck action inventory

2026-10-28. Create/convert ingestion commit: `1bc8f5d7`. Base: `e7b1e651` (current checkout, following the requested currentmain2cc7f5f9 audit). This is local implementation evidence, **not final PRD acceptance**. Two independent Chromium contexts connect through actual workerd ArtifactRoom WebSockets. Shared mutations are observed in the other context at both 1280×800 and 390×844. The document fixture now uses the `workerd` resolver condition, as the deck fixture already did; otherwise its worker bundle tried to access `document` at startup.

The executable matrices are `apps/web/src/components/live-artifacts/fixtures/action-matrix.mjs` and `apps/web/src/components/live-decks/fixtures/action-matrix.mjs`, called from the existing real-room runners. Arrangement can use the room's production document/deck codec. Actions use mounted controls; the peer assertions read the independent peer, rather than accepting optimistic writer state. Real Clerk, provider, email, deployment, runtime and approval execution are not part of these fixtures.

## Section 4 / R1.15

| Exact PRD row/action | Actual mounted control | Peer assertion / boundary |
|---|---|---|
| Text: Bold, italic, underline, strikethrough, inline code | Text → Bold / Italic / Underline / Strikethrough / Inline code | Each mark appears in peer JSON; toggling it removes it. |
| Text: link | Link URL → Apply link / Remove link | Exact safe href appears, then link mark disappears. No navigation or external fetch. |
| Text: text colour from theme | Text colour swatches | Every schema theme swatch, not one representative: exact `textStyle.color` on peer. |
| Text: clear formatting | Clear formatting | Previously marked text has no marks on peer. |
| Case: UPPER CASE, lower case, Title Case, Sentence case | Case → corresponding four buttons | Exact transformed selected text on peer. |
| Blocks: Paragraph, Heading 1 to 3 | Blocks → Paragraph / Heading 1 / Heading 2 / Heading 3 | Peer node type and each heading level. |
| Blocks: bullet, numbered, check lists | Bullet list / Numbered list / Checklist | Peer bulletList / orderedList / taskList nodes. |
| Blocks: quote, code block, divider | Quote / Code block / Divider | Peer blockquote / codeBlock / horizontalRule nodes. |
| Blocks: slash menu for any of them | Type `/`, then each Insert block menu button | Each block above, plus Table, exercised through the mounted slash menu independently of toolbar. |
| Blocks: drag a block by its handle | Drag paragraph block; ArrowDown accessible equivalent | Peer first block changes to Second block. Native desktop drag and mobile touch drag are also exercised. |
| Tables: insert | Table → Insert table | Peer 3×3 table. |
| Tables: add/remove rows | Add row above / Add row below / Remove row | Peer row counts 4 → 5 → 4. |
| Tables: add/remove columns | Add column before / Add column after / Remove column | Peer column counts 4 → 5 → 4. |
| Tables: header row | Header row | Peer header cells change to normal cells. |
| Tables: cell colour from fixed set | Cell colour swatches | Every swatch appears as exact peer backgroundColor. Remove table also removes peer table. |
| Media: upload image | Upload image file input | Stored image appears and decodes in peer. |
| Media: paste image | Native ClipboardEvent with a File through mounted paste handler | A second stored image appears and decodes in peer. Cursor is arranged outside existing image selection. |
| Chips: mention person in artifact | Mention a person → Trusted bob | Peer mention value is bob. Roster is the real room roster. |
| Chips: date | Date chip → Insert date | Peer date value is 2026-10-28. |
| History: own undo / redo | Undo / Redo | Peer mark removal/restoration; existing runner also proves Bob's text survives Alice undo before and after reconnect (R1.16). |
| History: version history / restore | Version history → Restore Initial fixture → Confirm restore | Room restores initial content; both peer text and removal of newer live content checked. Fixture version listing is explicit; not D1 member history acceptance. |
| Comments: selection, reply, resolve, address agent | Document selection → Comment on selection; collaboration-panel Comment / Reply / Resolve / address-agent composer | Mounted production path inventoried. **Not newly executed here: LG.5 owns comments/runtime work.** These rows remain dependent on its independent member/guest two-browser evidence; no synthetic success callback substitutes for it. |
| Agent: select, Ask agent | Selection actions → Ask agent → shared collaboration panel | Same ownership boundary: existing callback tests are not real agent execution. LG.5 owns runtime/trigger acceptance. |
| Export: Download markdown from latest checkpoint | Download markdown | Actual browser download contains stored checkpoint text and excludes subsequently typed Uncheckpointed tail. Checkpoint codec renders the saved state; not current editor state. |

Additional R1.9 insertion control: Insert → Image URL → Insert image URL. Only the exact captured `https://public-images.example.com/captured.png` is resolved by the fixture leaf. Bytes and ownership are stored in actual DO SQLite before the URL is returned; the peer renders only a `/files/<room>/<id>` URL and decodes it. The fixture leaf does **not** claim production R2 upload authorization. The existing `src/server/live-artifacts/production.test.ts` separately exercises production service ingestion, R2/D1 ownership, actual room registration and checkpoint image publication with captured outbound bytes. The browser runners replace the app's Google Fonts stylesheet with empty captured CSS, abort all other external HTTP origins, and assert no external image request. No arbitrary upstream image host is tested.

## Section 5 / R2.3

| Exact PRD action | Actual mounted control | Peer assertion / local-view assertion |
|---|---|---|
| Add slides | Add slide | Existing runner adds from both browsers; peer slide count becomes four. |
| Duplicate slides | Duplicate slide | Peer count 2 → 3. |
| Delete slides | Delete slide | Peer count 3 → 2. |
| Reorder slides in left strip | Move slide 2 later / Move slide 3 earlier | Ordered peer ids equal writer ids after each action; no duplicate slide. |
| Select elements | Elements and layers → shape: box, Shift-select text: headline | Mounted selection enables geometry/alignment/group controls; real room presence preserves selected ids. |
| Move | Inspector x / y | Exact peer props 410 / 130. |
| Resize | Inspector w / h | Exact peer props 210 / 110. |
| Rotate | Inspector rotate | Exact peer prop 25. These are the mounted numeric alternatives to stage handles, usable at phone width. |
| Align | Align left / center / right / top / middle / bottom | Each action is followed by peer scene equality before proceeding. |
| Group | Group | Peer contains one group. |
| Ungroup | Ungroup | Peer group count returns to zero. Subsequent notes/grid/pointer actions keep the room alive. Fixed stale deleted-group selection causing Unknown selection rejection. |
| Edit text in place | Stage text Tiptap; Edit table cell 0:0 | Existing runner types concurrently from both profiles; both strings survive in peer text and cell; own text undo/redo preserves other's edit. Bullet list mutation is checked through production rich-text codec. |
| Set fill from theme | **New** Apply theme fill | Exact theme colour reaches peer background-color. |
| Set border from theme | **New** Apply theme border; border-width | Exact theme colour reaches peer border-color; width reaches peer style. |
| Set font from theme | Add fonts token → Apply theme fonts | Shared theme contains Arial; peer font-family is Arial. Never bypass closed theme validation. |
| Set size from theme | Add sizes token → Apply theme sizes | Shared theme contains 28px; peer font-size is 28px. |
| Transition per slide | Transition select | Every none / fade / push / magic reaches peer slide. |
| Builds per element | build-in / build-out; Build order; Build trigger | Every fade / rise / drop / left / right / scale / pop for both directions; order 2 and each click / withPrevious / afterPrevious reach peer. |
| Speaker notes | Speaker notes textarea | Exact Shared presenter notes reaches peer. |
| View all slides in grid | All slides / Slide strip | Local grid mode enters/exits; shared scene is retained. A local view preference does not alter peer view. |
| Present full screen | Present; F | Presentation mounts; F enters actual document.fullscreenElement. |
| Keyboard Right / Space / Left / Home / End / Escape | Real page key events in presentation | Position advances by Right and Space, returns by Left; Home/End select first/last slide; Escape exits. |
| Presenter view with notes and next slide | Presenter notes | Stored shared notes and actual next-slide scene are visible. |
| Comment on slide | Comment on selection with empty elementIds → deck-collaboration composer | Mounted production path inventoried; owned by LG.5 comments/runtime work, not reimplemented in this fixture. |
| Comment on element | Elements and layers selection → Comment on selection | Exact slideId / selected elementIds passed to production composer; LG.5 peer-service acceptance remains required. |

Existing deck real-room runner retains authoritative concurrent key edits, embed isolation, empty-cell allocation, presentation broadcast/stop and reconnect/restore assertions. Presentation broadcast is checked on Bob; private presenter/grid preferences are checked locally. No guest UI, auth/approval core, schema or migration metadata policy is modified.

## R1.9 create/convert implementation and remaining guarded-op handoff

`createDocument` and static `convertDoc` now invoke the authorized async image-resolution hook before shared sanitization. The same DOM-free Markdown parser enumerates image nodes, including reference-style images, without fetching code examples or raw HTML. The shared sanitizer, synchronous importer and allowed grammar are unchanged. After resolution, the codec substitutes only stored `/files/<id>` paths and passes them through the existing sanitizer with exact new-artifact ownership.

Bounds: at most **16 unique image URLs**, **8 MiB aggregate fetched bytes**, **30 seconds aggregate**, with each existing fetch retaining its maximum ten-second deadline, three validated redirects and raster signature/MIME checks. Repeated URLs within one import fetch/store once. Source Markdown is bounded by the existing document byte ceiling before parsing. Unsafe/non-public URLs, failed fetches, unsupported sources or missing storage refuse the import; no fallback hotlink is accepted.

Authorization is checked before I/O, after I/O, before ownership publication and again immediately before the artifact/version transaction. Static conversion rechecks current source write access; stored or principal guest-run scope refuses creation before transport. File blobs are privately staged under fresh ids; **file rows join the existing artifact/version/quota atomic transaction**. No file row is published independently. The new artifact's image manifest exists before checkpoint rendering and accepted content. Failed creation removes the unique staged file bytes and image ownership manifest only when no committed artifact row exists. A lost transaction acknowledgement preserves committed file rows, bytes and ownership; an unavailable DB likewise does not authorize destructive cleanup. Shared content-addressed checkpoint blobs/manifests retain the existing publication/garbage-collection policy: cleanup does not blindly delete potentially shared blobs. All cleanup operations are attempted; storage cleanup failures propagate rather than being claimed successful.

Evidence: `apps/web/src/server/live-artifacts/import-images.test.ts` uses real migrated services and production codec/storage adapters for create and convert, reference-image deduplication, denied fetches, private redirect refusal without a private request, count/byte/time limits, revocation during fetch and after ownership storage, atomic commit failure, ownership write failure, lost-commit-acknowledgement preservation and scope changing during I/O. The production workerd fixture additionally runs MCP artifact_create with Markdown images against captured public transport, real file rows/R2 bytes, exact ownership and the published checkpoint; its actual static-doc conversion consumer produces independently owned files on the new artifact.

**Remaining R1.9 core-coordinated blocker: guarded `document_edit` Markdown image insertion still silently drops external image nodes.** The service create/convert fix does not change this behavior. Relevant path: `apps/web/src/server/mcp/live-ports.ts` edit → `apps/web/src/server/live-artifacts/production-room.ts` documentEdit → `translateBatch` → guarded room edit / `packages/live-doc` synchronous importer (`fromMarkdown` sanitizer). Text can be accepted while the external image is omitted; no third-party hotlink reaches accepted scene content, but required fetch/store-at-insert behavior is absent.

Next implementation boundary: an authorized image staging/resolution step **inside the guarded, idempotent room-operation lifecycle**, after guard admission and before accepted shared content, with exact ownership and artifact quota handling. It must preserve R1.24 **no writes on guard mismatch**, concurrent human-edit guards, current permissions, immutable original request digest, stable generated file ids and change id across crashes/retries, suggestion semantics and scoped-guest external-fetch refusals. Failed guarded writes must clean their staging without removing assets used by an accepted/replayed operation. Preprocessing or fetching in the MCP adapter would write before guard admission and destabilize retry digests; do not use it. The controller explicitly directed this extension remain a prominent handoff item in this constrained finish. No room protocol/auth/approval extension or provider-blocked migration/security probe was performed.

## Verification and limits

- Two real-room runners: desktop 1280×800 and touch-capable 390×844; production document and deck codecs; actual two-browser WebSocket convergence. Both runners pass at both sizes, including native desktop drag and real mobile touch drag.
- `bun run test`: final run passes all 12 workspace test tasks and 284 repository-script tests. No provider keys or sends supplied. The subsequent narrowly scoped acknowledgement-loss fix passes all **13** real-service/codec import tests (44 assertions); no additional broad suite was started.
- `cd apps/web && bun test src/server/live-artifacts/import-images.test.ts src/server/live-artifacts/production.test.ts`: earlier 11/11 pass, including real production workerd/R2/D1 create/convert; root run additionally includes the ownership/access-loss cases added afterwards.
- `cd packages/services && bun test src/live-artifacts/external-image.test.ts`: 5/5 pass, 48 assertions, after the final equivalent deadline-expression lint adjustment.
- `bun run build`: passes; client bundle contains no drizzle; boundary lint clean.
- Ordinary `bun run check` attempted: missing secret Env fields after automatic `wrangler types` without any environment file. Explicit authorized `cd apps/web && bunx wrangler types --env-file .env.example`, followed by `bunx turbo run typecheck --only`, validates all eleven typecheck packages without creating an environment file. Ultracite and boundary stages run separately.
- Local issuer, controlled identities, SQLite captured image leaf and fixture version listing are explicit substitutes. Signed staging must still execute these controls through real app routing, D1 history, R2, two distinct Clerk members, real access revocation and deployed public-only ingestion. No deployment, push, PR, provider send, secret access or subagent work was performed.
- This inventory narrows the action audit gap but does not close R1.15/R2.3 in full until LG.5 comment/agent rows and the guarded `document_edit` R1.9 gap have their required implementation/evidence. It is not a security review or a migration remediation approval.

## Bounded implementation review

Self-review (no independent reviewer/subagent was started): verified that URL inspection uses the same Markdown parser, replacements still enter the existing sanitizer, rejected imports do not commit file rows, and exact new-artifact image ownership precedes checkpoint rendering. The existing artifact quota statement remains in the same atomic transaction as creation/version/file rows. Cleanup targets only fresh private file ids and the new artifact manifest; it does not delete shared content-addressed checkpoint data. Existing room guards, operation digests, suggestion origins, auth/approval and guest external-fetch denials are untouched. LG.5 was notified of the additive creation/service and compose hunks for integration.

Uncovered PRD rows remain explicit: **R1.9** guarded `document_edit` external-image ingestion; **R1.15 / section 4 Comments and Agent** peer execution belongs to the active LG.5 lane; **R2.3 / section 5 slide and element comments** requires LG.5's service-backed peer evidence. Signed staging execution for every row remains an acceptance gate. No all-actions or full R1.9 completion claim is made.

Final code commits before this evidence commit: `1bc8f5d7` (bounded create/convert ingestion) and `a2050e19` (mounted action matrices plus deck fixes). Follow-up acknowledgement-loss preservation is included with this evidence. Root example-generated typechecks pass 11/11; root build passes 5/5 tasks; Ultracite, boundary lint and client drizzle scan pass. Ordinary `bun run check` remains limited by default secret-less type generation, as recorded above. This is the committed constrained handoff requested by the controller, not all-phase acceptance.
