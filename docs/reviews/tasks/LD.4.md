# LD.4 — guarded deck MCP tools and executable scene adapter

Implemented on `t3/deck-mcp-read-write-tools`; implementation commit `77158e47`.
Read `CLAUDE.md`, task LD.4, PRD §7 and R2.4/R2.5, and the LD.0, LD.2 and L.5
reviews including controller resolutions. This completes the bounded tool/adapter
leaf, not phase 2 production acceptance. No app registration/composition, services,
core/codec, document tools, artifact_create, deck UI or task files changed.

## Public APIs for L.7 / phase 2

`@repo/mcp/tools/deck` exports:

- `deckReadInputSchema`, `deckOperationSchema`, `deckWriteInputSchema` and their
  `DeckReadInput`, `DeckWriteInput`, `DeckReadResult`, `DeckWriteResult` types.
- Mandatory `DeckPort` with async `read(input)` and `write(input)`; no default or
  mock-success port. Its host binds the authenticated principal/workspace, agent,
  run and tool-call identity. Identity is never a tool argument.
- `deckTools(port)` definitions and
  `registerDeckTools(server, port, {dryRun?, readOnly?})`. Registration uses the
  existing `registerTools` error boundary and dry-run recorder. A read-only server
  omits deck_write. Annotations are exactly READ_ONLY and WRITE_UPDATE. Both tools
  return text plus structured data; neither returns images.
- `DeckCreationPort.create({title, slides?: string[]}) -> {artifactId, url}`:
  slides are constrained HTML strings. The future artifact_create adapter owns
  allocation, authenticated creation, persistence and URL generation.

`@repo/mcp/tools/deck-scene` exports:

- `new DeckSceneAdapter(ports)`, implementing DeckPort, and idempotent `destroy()`.
- Required `DeckScenePorts`: `artifactId`, `authority: Deck`,
  `authorize(action: "read" | "write", artifactId): Promise<void>`, synchronous
  authoritative `presence()` and synchronous artifact-specific `ownsBlob(path)`.
  Construction refuses missing authorization/presence/ownership callbacks.
- `createDeckCheckpoint({title, slides?}, ownsBlob): Uint8Array`: builds an isolated
  initial Y.Doc with the actual Deck and production richTextCodec, validates every
  slide and the complete scene, and returns actual Yjs bytes. It never changes an
  existing room or persists partial creation. Authorize creation before calling
  it; persist/allocate only after it succeeds. Admission still uses Deck.applyUpdate.

The package's existing wildcard exports expose these narrow entries. Only the
`@repo/live-deck` workspace dependency and existing pinned Yjs dependency were
added to mcp/package.json and bun.lock. No root server import or registration was
added: L.7 must explicitly call registerDeckTools on the existing runtime server.

## Strict wire contract

All input objects are strict, including nested ops/theme. Caller snapshots,
identity, raw scene/marks, arbitrary paths, unknown operations and force flags
are refused by the MCP schema before the port runs.

`deck_read({artifactId, slideIds?})` selects one/several slides; omission reads all.
Duplicate selections are refused. It returns `{artifactId, deck, slides, present}`:

- `deck`: `{order: string[], sections: {id,title,order}[], theme, revision}`,
  rendered as deck.json in text. Theme has colors/fonts/sizes token dictionaries.
- `slides`: `{id, html, revision}[]`; revisions are unpredictable opaque tokens.
- `present`: `{id, name, slideId?}[]` from the authoritative presence port, detached
  before returning. Presence and deck content appear in the text result too.

`deck_write({artifactId, ops})` accepts 1–100 ordered operations:

| op | Required fields besides op | Guard |
| --- | --- | --- |
| write | slideId, html, revision | slide revision |
| add | html | core requires fresh/nonexistent slide ID |
| delete | slideId, revision | slide revision; any intervening slide change skips deletion |
| reorder | slideIds, revision | deck revision; permutation of current staged slides; any intervening slide change skips reorder |
| theme | theme, revision | deck revision; changed theme tokens guarded independently |

Reorder uses new core fractional keys in the stated order. Add/delete/reorder/theme
and HTML writes can share a batch. A valid batch returns
`{applied: {index, keys}[], skipped: {index, id, reason}[]}`. Core element IDs,
slide/layout paths and skip reasons are preserved; the operation index disambiguates
slides. Missing slides with valid observations are skipped with explicit guidance
not to recreate them. Deleted/recreated slides retain their intervening history.
After success used capabilities are consumed, including all-skipped proposals;
read again before another proposal. A token can be referenced by multiple ops in
one batch. There is no automatic retry or unguarded/force alternative.

## Authority, history and atomicity

One adapter is retained with the synchronized authoritative Deck for the room's
lifetime. The authority is already trusted/validated; persisted or untrusted bytes
must first enter an empty Deck through applyUpdate/restore. The adapter creates
an isolated shadow authority using the same production richTextCodec and ownership
callback, and synchronously forwards ORIGINAL authority updates to that shadow.
Remote edit/revert history and CRDT identities survive; no snapshot-derived guard
or weak/content hash is used. HTML snapshots are views, never observation authority.

Eight bounded core observation readers share the shadow document so an all-slides
read can cover the core's 500-slide limit without the core's per-reader 128-token
count limit immediately expiring the first slide. Wrapper storage retains up to
1,024 slide capabilities and 64 deck capabilities. Core per-reader observation
byte/count/history ceilings still apply; eviction requires a new read. Structural
and theme guards use actual Yjs deep-event counters, including parent replacements;
ID churn exceeding 4,096 tracked paths expires wrapper capabilities and clears
that bounded structural history. Returned values are detached. Closing/replacing
the adapter invalidates every capability.

After awaiting mandatory authorization, reading/staging/admission is synchronous
with no further await. Each complete batch executes on the shadow; guarded slide
writes call the real core write API against retained observations. Unchanged agent
keys remain untouched; an intervening edit skips that whole element, while slide
settings and layout keys merge independently. Theme tokens merge independently;
structural delete/reorder guards are deliberately conservative. All writers count
as intervening edits. The final original CRDT delta enters the real authority once
through applyUpdate, producing one update for a successful changed batch.

Invalid HTML/theme/reorder or an invalid final partial merge aborts the batch before
any authority mutation. The shadow is discarded and rebuilt from the authority;
all earlier capabilities then require fresh reads. No rollback transaction or
partial success is applied to the authority. Missing/forged/consumed/evicted tokens
return guard_mismatch; core expired-observation errors map to that same code.
Expected host ToolError codes/messages survive unchanged. Core `/path: diagnostic`
errors become validation with the complete original message/path verbatim. Unknown
exceptions remain masked by the existing MCP error boundary.

Core and accepted codec remain the only scene/rich-text schema authorities. The
adapter neither recreates their grammar nor sanitizes hostile input into success.
Image admission checks actual artifact blob membership, including safe-looking
foreign paths; recognizing `/files/` alone is insufficient.

## Verification

- `bun install --frozen-lockfile --ignore-scripts`: passed for initial dependencies;
  `bun install --ignore-scripts` then recorded the two declared workspace/package
  dependencies in bun.lock, with no version upgrade.
- Focused real MCP/client → adapter → actual Y.Doc/core suite:
  `bun run --cwd packages/mcp test src/tools/deck.test.ts`: **16 passed, 0 failed,
  79 assertions** on the final files.
- `bun run --cwd packages/mcp typecheck`: passed.
- Root `bun run check`: **11/11 tasks passed**, Ultracite and boundary lint clean.
- Root `bun run test`: passed to completion, including actual core/codec workerd
  suites and the **284 root script tests**, zero failures. Existing web skip remains.
- Root `bun run build`: **4/4 tasks passed**; existing Vite CSS sourcemap warning only.
- `bun build packages/mcp/src/tools/deck-scene.ts --target browser --outfile
  /tmp/ld4-deck-scene.js`: passed (209 modules). Its emitted bundle contains none
  of cloudflare:workers, bun:sqlite, @repo/db or drizzle. This is a browser-target
  bundle check, not a claim of production room or adapter workerd integration.
- apps/web/dist/client exists and its files have no drizzle matches.
- `git diff --check`: clean.

Focused tests use actual in-memory MCP transports and the production codec/core,
not mock mutation ports. They cover strict schemas, text/presence and selected/all
reads, exact annotations, read-only filtering, actual authorization refusals and
cross-artifact binding, missing required ports, dry-run zero writes/recorder,
per-element and independent layout-key merges, rich-text human wins, original
remote edit/revert ABA, deleted/recreated/gone slides, consumed/forged tokens,
structural delete/reorder guards, independent theme-token ABA/merges, add/delete/
reorder/theme in one admitted update, aborted batches with identical authority
bytes and zero events, invalid theme/reorder rollback, hostile HTML/attributes/
links/CSS/paths/foreign blobs, raw-mark admission refusal, creation checkpoints,
and exact core error/path translation.

The checkout had no apps/web/.env. Validation temporarily copied .env.example,
then removed that file only after verifying it still equaled the example. No
existing environment value was overwritten. No push, PR or deployment.

## Integration gates

L.7 / phase 2 must bind real authenticated room/service ports, register these
exports across Pi/Managed Agents/machines, add the platform approval label/key
`harbourmaster/deck_write` through the existing approval resolver, and wire deck
creation into artifact_create. No approval bypass is introduced by this leaf.
The real authorize callback must enforce workspace/artifact kind, created/handed/
in-artifact run scope, and guest artifact scope/role on each call. This leaf tests
callback enforcement/refusal; it does not claim production policy implementation.

The room owns admission serialization/rate limits, validated editor ingress,
attribution/history summaries, authoritative awareness, accepted-update persistence/
broadcast, room teardown and rejected-client resynchronization. Retain both core
and adapter until room replacement and destroy the adapter before the authority.
Persist actual Yjs state, never HTML. Bind own-blob membership deterministically
throughout each synchronous admission. Static/live refusal guidance, creation
lifecycle cleanup, runtime approvals and real service/room round trips remain
controller integration gates. Core APIs were sufficient; no core edit was needed.

## Independent review — merged main 335ca888

Verdict: **accepted for the bounded LD.4 tool and adapter leaf; no severity-rated findings**. Reviewed implementation `77158e47` and handoff `fe990bc0` against CLAUDE.md, LD.4, PRD §7 and R2.4/R2.5, and the accepted LD.0/LD.2 contracts. This is not production or phase 2 acceptance.

The strict MCP schemas, registration filtering and dry-run path, mandatory authorization callbacks, real Deck and rich-text codec, capability scoping and consumption, original-update shadow synchronization, per-element and per-key merging, structural and theme guards, atomic staged admission, ownership checks, validation error translation and isolated creation checkpoint were inspected. The implementation depends on a retained room adapter and synchronized authoritative Deck; capabilities are scoped to that adapter instance and invalidated on reset or destruction. Authorization policy is supplied by the host and must be checked on every call.

Checks independently run on merged main after `bun install --frozen-lockfile --ignore-scripts`:

- `bun run --cwd packages/mcp test src/tools/deck.test.ts`: **16 passed, 79 assertions** against actual MCP transport, adapter, core and codec. The initial attempt failed because dependencies were absent; the frozen install resolved it.
- A temporary independent Bun probe made a remote replica change and revert a theme token and slide notes, admitted its aggregated original Yjs update, then submitted an old theme/delete proposal. The changed theme token and deletion were skipped, an independently changed theme token applied, and replay of the consumed revision failed: **1 passed, 3 assertions**. Probe removed after execution. This exercises one adversarial history, not all possible Yjs interleavings.

Mandatory integration gates remain: real authenticated service and room policy for workspace, artifact kind, run and guest scope on every call; serialized validated room admission, ownership, presence, attribution, persistence and broadcast; runtime MCP registration and approval resolver wiring; creation allocation and persistence; and real room/service round trips. Callback tests and in-memory Yjs admission do not establish those gates or production authorization/persistence. No mock-success port is accepted as evidence for them.
