# LD.0 — bounded deck core implementation

Implemented in `packages/live-deck`, based on prototype `b5b0b2cc98d6ffe92e8d5cebe44877fbb8209e08`, merged into the assigned branch. No live-doc, service, MCP, protocol, schema or UI changes. This leaf supplies the phase 2 scene core; room/editor/tool integration and shared L.2 rich text remain phase acceptance gates.

## Scene and editor contract

`new Deck(doc, codec, options)` takes a trusted empty or already validated Y.Doc, a mandatory synchronous `RichTextCodec`, and optional `{ ownsBlob, maxObservations }`. Keep an authority instance alive for the room lifetime; call `destroy()` when replacing it. Never construct it around bytes already applied from an untrusted source. Bootstrap persisted/network bytes through `applyUpdate` or `restore` on an empty document instead.

The Yjs roots are maps named `meta`, `sections` and `slides`. Meta has a bounded title and a theme map containing per-token `colors`, `fonts` and `sizes` maps. Sections have stable IDs, title and fractional order. Slides are stable ID map entries; order, background, transition, duration and optional section are scalar keys, layout is a per-key map, notes a plain Y.Text, and elements a stable ID map. Each element has scalar type/parent/order and independent props/style maps. Text boxes contain Y.XmlFragments. Tables have a map from zero-based `row:column` keys to Y.XmlFragments. Unallocated cells are logically empty; `cellFragment` allocates an empty fragment through a validated transaction when needed. Resizing a table with occupied out-of-range cells is refused; the caller must explicitly update/remove those cells.

Slide methods: add, delete, duplicate with supplied fresh element IDs, move between fractional neighbors, and update slide settings/layout/notes/section. Element methods: add, delete (including descendants and incident connectors), duplicate (groups require descendant ID mappings), move/reparent/reorder, group, ungroup, per-key property/style setters, whole-element patches and atomic multi-element patches. Geometry patches support movement, resizing, rotation and alignment. Text and cell patches use the injected codec. Group/slide duplication remaps internal connector endpoints. `ids()`, `sections()` and `orderedElements(slide, parent)` use fractional order and stable ID tie breaks. Raw `read().slide.elements` is a canonical ID-sorted flat scene, not presentation order.

`textFragment` and `cellFragment` expose types for a **trusted local editor** to bind to. These references and the public Y.Doc are not an untrusted ingress API. Editor updates crossing into the authority must pass through `applyUpdate`; the model operation methods stage and validate their complete result before committing. Accepted mutations retain per-key CRDT granularity, including unchanged rich text fragment identity.

## Agent read/write contract and ABA protection

Prefer `readHtml(slideId) -> { html, revision }` and `write(slideId, desiredHtml, revision)`. The revision is an unpredictable opaque capability scoped to this Deck instance. The authority retains a detached baseline and mutation history; it never reconstructs authority from caller-supplied values. `read` additionally returns a detached scene and opaque element revision labels. The compatibility `write(..., observationObject)` overload verifies the entire object against its retained copy and refuses tampering.

Deep Yjs events advance guards for element subtrees, slide properties, individual layout keys and slide deletion/recreation. A human edit followed by a revert still changes the guard, including remote updates containing the complete edit/revert history, text fragments and notes. On write, unchanged agent keys are left alone; edited elements changed since read are skipped in full. Slide settings and individual layout keys merge independently and report their skipped keys. `WriteResult` lists applied element IDs/key paths and skipped IDs with reasons. All writers, including other agent runs, conservatively count as intervening edits.

Guards can only cover updates received by the authority. Always serialize writes on the synchronized authoritative room document, never an offline agent replica. Retained observations are bounded to 64 by default (configurable integer 1–128), approximately 4 MB of serialized observations, and bounded history storage. Eviction, restart, restore or history-budget invalidation requires a fresh read; stale/unknown tokens are refused. The returned snapshot is never the retained object. Structural conflicts in the final partial merge (for example an orphan caused by retaining a human-edited child while deleting its group) refuse the entire write atomically; callers must reread and repair the proposal.

## Incoming updates, convergence and restore

All network/editor/import Yjs bytes go through `Deck.applyUpdate`, **before** the live Y.Doc receives them. The method synchronously clones the authority's current structs/deletes into an isolated candidate, applies the untrusted bytes there, rejects unresolved pending structs/delete sets, then validates all roots, types, fields, text, URLs, references, themes, geometry and aggregate limits. Invalid input changes neither live state nor observation history. A successful admission applies the **original** update to the authority, preserving Yjs client IDs, clocks, delete sets, independent edits, duplicate delivery and convergence. It does not regenerate the scene from JSON. Authority model operations similarly stage their mutations, validate the whole candidate and commit the resulting original CRDT delta using a stable local author identity.

The room layer must authenticate/authorize and rate-limit before admission, serialize admission without intervening mutations, and broadcast/persist only accepted updates. Missing dependencies require a full/dependency-complete resynchronization and retry. Rejected optimistic client branches must be discarded and rebuilt from an authoritative checkpoint, then valid user intents reapplied. Merging the server snapshot into a client that still retains rejected structs is insufficient: rejected client clocks and dangling dependencies remain. Arbitrary invalid concurrent states cannot both be admitted; for example, when two independent valid additions would jointly exceed 200 elements, the first admitted update wins and the second is rejected. This is admission control, not post-application rollback or automatic repair.

`restore(bytes)` validates a complete checkpoint independently, then replaces the authoritative roots in a newly authored transaction. It does not merge an old checkpoint's historical structs into the room. The replacement propagates as normal CRDT changes to current replicas and invalidates observations. Invalid/incomplete/oversized checkpoints leave the live scene unchanged. The encoded-history ceiling also applies to the resulting live document; long-lived rooms approaching it need a service-level fresh-document epoch/compaction strategy, outside this package.

## HTML, URLs, theme and resource boundary

Slide HTML is XML-shaped constrained interchange with explicit closing tags, `slide`, text-only `notes`, flat `element` nodes, and table `cell key="row:col"` nodes. IDs, fractional keys, parent references, element types and every attribute have an explicit grammar. Unknown tags/attributes/properties, duplicate attributes/cells/IDs, comments, CDATA, processing instructions, doctypes, malformed entities, cycles and invalid cross-references are refused. Errors identify slide/element/cell/attribute paths. HTML is a view only; render validated scene values with platform components, never this string through innerHTML.

Layout allows flex/grid display, direction, gap, padding, alignment/justification and bounded `repeat(n, 1fr)` tracks. Props cover pinned geometry, constrained flow/grid positioning, image src/alt, table dimensions, shape kind, icon identifier, connector endpoints/anchors, and the PRD build effects/order/triggers. Styles are a fixed allowlist of hex/transparent colors, px lengths, font family, weight, opacity and text alignment. No arbitrary CSS, URL expressions or custom variables. Color lengths are exactly 3/4/6/8 hex digits. Font family must belong to the current theme's font values; removing an in-use font is refused. Theme tokens have checked IDs, at most 100 per category, and property-specific value grammars.

`parseSlide` and `serializeSlide` enforce syntax/schema and resource bounds; artifact blob ownership and current-theme membership are enforced by Deck admission. Do not treat a standalone parsed scene as artifact-authorized input. Both the scene and escaped serialized HTML must fit their byte bounds, so accepted scenes remain readable through the HTML API.

Image paths must be canonical single-slash `/files/...` paths with safe segments **and** satisfy `ownsBlob(path)`. Missing ownership policy denies all images. The callback must synchronously verify membership in this artifact's blobs, not merely recognize the route prefix, and be deterministic during validation. External image fetching/uploading is an integration responsibility. `validateLinkUrl` supplies the shared codec with a strict http/https/mailto or same-origin-page-path check; it rejects executable schemes, protocol-relative paths, credentials, backslashes, controls and malformed escaping. Outside links still need platform rendering with `noopener noreferrer`.

`RichTextCodec.parse` and `.serialize` are both trusted schema validation boundaries. L.2 must supply a DOM-free, deterministic implementation backed by the shared live-doc schema and restricted deck text subset: paragraphs, lists, allowed inline marks and safe links, refusing every unknown node, mark and attribute with a path. Serialize must inspect and validate the actual Yjs structure, not silently drop unknown source attributes/nodes. Parse must reject unsupported content rather than silently normalize it away. The core validates generic shape/complexity and checks parse/serialize round trips for loss, but intentionally does **not** duplicate L.2's schema. The test codec only supports plain paragraphs and is not production code. Text font overrides outside the deck subset must be refused by the supplied codec; element font styling goes through the theme boundary.

Limits: 500 slides, 500 sections, 200 elements per slide, 24 pinned children per group, 4000 table cells across the deck, group/text depth 16, 20,000 nodes per text fragment/HTML parse, 2,000,000 UTF-8 bytes per slide/HTML input, 16,000,000 bytes per Yjs update/checkpoint and encoded authoritative scene, title/section title 500 characters, IDs 80 characters and fractional keys 128 characters. All final scenes are validated after merging, so concurrent writes cannot bypass the limits at the authority. Root maps cannot hide array content; notes cannot contain embeds or formatting.

## Verification

Final commands and outcomes are recorded after the last implementation change below. `bun install --frozen-lockfile` passed after the clean prototype merge, with no package/lock conflicts. The ignored `apps/web/.env` was copied from `.env.example` as prescribed by CLAUDE.md/CI so generated Env declarations include template secret names; no real credentials or application source changes were needed.

Focused coverage includes real independent replicas, independent property and theme edits, competing slide moves with one copy, original-update byte convergence/idempotence, local and remote ABA, deletion/recreation, text/notes/layout ABA, opaque/forged/expired observations, preserved untouched fragment identity, group and connector operations, table fragment edits, hostile HTML and Yjs, incomplete dependencies, own-blob policy, strict URL/theme grammar, limits, concurrent overflow, invalid restores and convergent checkpoint replacement. Prototype lint failures were fixed by named imports, real type-safe fixtures, grammar constants and smaller functions; no rules were disabled.

Dependencies are lock-pinned to Yjs 13.6.33 and fractional-indexing 3.4.0 (MIT), and saxes 6.0.0 (ISC). L.2/schema/room/service/editor integration remains a separate gate; this task does not complete phase 2.

### Final recorded results (2026-10-27)

- `bun install --frozen-lockfile`: passed after merge; lock/package inputs unchanged thereafter.
- `bun run --cwd packages/live-deck typecheck`: passed.
- `bun run --cwd packages/live-deck test`: 23 passed, 0 failed, 170 assertions.
- `bun run check`: passed; root Ultracite clean, 10/10 typecheck tasks successful, boundary lint clean. No lint-rule suppression.
- `bun run test`: passed to completion; 10/10 package tasks successful, 8,088 passed in total including the 284 root script tests, one existing web skip, zero failures. The final package run was uncached.
- `bun run build`: passed, 2/2 tasks successful (final replay cached after an earlier successful full build). Existing Vite CSS sourcemap warning is non-fatal.
- Client bundle search for `drizzle`: no matches. `git diff --check`: clean.

The initial full-run deck limit fixture exceeded Bun's default five-second timeout under concurrent suites. The fixture now loads 499 valid slides directly, then exercises actual validated 500th/501st admissions and invalid ingress/restore; no timeout was increased. The full suite passed after that change and the final serialized-HTML expansion regression.

## Independent review (2026-10-27)

Reviewed main at `381134df93fdf1be048cc1ce10119c9e6330cfcc`, including implementation `10dbdf15` and merge `d998ce00`. Verdict: **changes required for the bounded core**. The findings below are within LD.0's own HTML and scene contract; the production rich-text codec, room, editor and tools remain separate phase 2 integration gates.

### P2 — Unknown `__proto__` HTML attribute is silently accepted

`parseXml` copies saxes attributes into a normal `{}` using `attrs[k] = String(v)` (`packages/live-deck/src/index.ts`, `parseXml`). The inherited `__proto__` setter consumes a string assignment without creating an own property, so `checkAttrs` never sees it. Reproduction with a codec whose `parse` is a no-op and `serialize` returns `[]`:

```ts
parseSlide('<slide id="s" order="a0" background="#fff" transition="none" duration="0" __proto__="x"></slide>', codec)
```

This returns a scene instead of rejecting the unknown attribute; replacing `__proto__` with `constructor` is rejected. This violates R2.5's refusal requirement and the reported strict unknown-attribute guarantee. The attribute does not itself reach the returned scene in this reproduction; this is an input validation failure, not evidence of script execution. Use a null-prototype attribute dictionary or explicitly reject the name before copying, and cover slide, element and text attributes.

### P2 — Accepted notes can make the HTML read/write API non-round-trippable

`validateSlide` accepts any string for notes and `escapeHtml` does not reject XML-disallowed characters. With the same empty codec, add a valid empty slide with `notes: "\u0000"`; `deck.readHtml("s")` returns HTML containing that NUL, and `parseSlide(read.html, codec)` throws `disallowed character` at `/slide/notes`. Thus a locally authored or admitted Yjs scene can pass validation and be unreadable to an agent that attempts to write back the returned HTML. Validate XML character legality for all strings represented in HTML, including notes and trusted codec output, before accepting a scene; test local operations, Yjs admission and restore as well as round-trip.

### Verification and boundaries

- `bun install --frozen-lockfile`: passed; dependencies were absent initially. The initial focused test and typecheck attempts consequently failed before installation.
- `bun run --cwd packages/live-deck test`: passed, 23 tests and 170 assertions. `bun run --cwd packages/live-deck typecheck`: passed.
- Independent temporary Bun probes reproduced both findings above and confirmed a remote same-transaction element edit/revert is skipped by an old revision. Existing focused tests also exercise remote ABA, deletion/recreation, independent per-key edits, malicious candidate updates, missing dependencies, blob ownership, restore and concurrent limit admission. These checks do not prove safety for all possible Yjs histories.
- Production acceptance still requires the shared live-doc codec to validate actual Yjs rich-text structure and links, and room/editor/tools to enforce authenticated serialized admission, ownership, persistence/broadcast, and rejected-client resynchronization. These are separate integration gates, not findings against this bounded core.
