# L.0 independent review — 2026-10-27

Verdict: **changes requested**. Local workerd/browser checks reproduce, but one explicit L.0 experiment is missing, a clock/reconnect failure needs a negative result and fallback, and accidental fixture deployment is not mechanically blocked.

Reviewed current main `6a307bdf7e26025531c723128c8f8d9f086e5f00`, especially evidence commit `125d5583e4cd14da5f8be82a7b79afb640259cc5` (documentation only) and fixture implementation `abe8f903`. Branch: `t3/review-l0-live-realtime-spike`. Read CLAUDE.md, the task, live-spike.md, PRD L.0/L.3 scope, Cloudflare/Durable Objects/Wrangler skills and installed upstream implementation. Consulted current [Cloudflare hibernation documentation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/). No product/task edits, deployment, push, checkout setup or delegation.

## Must-fix findings

### P2 — Exercise relative insertion across the browser/room boundary

Locations: `scripts/spikes/live-artifacts/worker.ts:44-56`, `docs/v3/live-spike.md:15`; requirement: `docs/v3/live-artifacts-prd.md:661`.

The insert probe uses two Y.Text replicas inside one synchronous RPC. The human update is fully applied before the agent resolves and inserts. Browser tests only perform ordinary offset-zero inserts, without agent RPCs or relative positions. This proves a Yjs primitive, but does not answer the explicit L.0 question of an agent insert while a browser types in the same paragraph. The evidence accurately admits this limitation, yet declares the spike complete and moves the check to L.2.

Remedy: add a browser/DO probe capturing a relative position before a browser edit, inserting through the room and asserting both browser replicas converge with both contributions. Include overlapping/unmerged edits if claiming concurrency. Full rich-editor fidelity can remain L.2. Record the actual run and decision, or mark this question incomplete with a concrete fallback.

### P2 — Record demonstrated clock/reconnect failure and choose a fallback

Locations: `scripts/spikes/live-artifacts/worker.ts:268-303,309-320`; evidence decision: `docs/v3/live-spike.md:13`.

Raw client clocks pass through unchanged. Close removes awareness state and SQL ownership, but retains awareness metadata clocks, including clocks already sent to peers. A fresh signed ticket with the same client ID can connect successfully while normal low-clock presence is suppressed. This occurs after a clean close, not just an abandoned reservation.

Independent local reproduction in room `review-clock`: observer client `987654321`; first connection client `123456789`, signed identity `first`, sent its own awareness entry at clock `999999` with a forged display name. Observer received sanitized identity `first` at clock `999999`, then null at the same clock after clean close. A fresh ticket for client `123456789`, identity `replacement`, upgraded successfully and sent clock `1`; observer received no replacement state (`replacementPublished:false`). The checked-in browser test only sends a high clock for the other client's ID, rejected before this path. This does not forge another participant's identity, but does disprove robust reconnect presence.

Remedy for L.0: retain a regression probe and document this negative result with an explicit strategy, such as connection-unique awareness IDs or server-managed monotonic clock translation accounting for peer metadata. Deleting only server metadata is insufficient because peers retain clocks. Full lifecycle implementation remains L.3; the spike needs an honest negative result and decision, not a production lifecycle implementation.

### P2 — Mechanically prevent accidental fixture publication

Locations: `scripts/spikes/live-artifacts/wrangler.jsonc:1-11`, `scripts/spikes/live-artifacts/worker.ts:124-125,348-352`.

Root workspace/import/deploy isolation protects normal product builds. However, the standalone config is an ordinary deployable Worker with migrations and a public issuer/key. Package `private:true` does not prevent Worker upload; naming it local and documenting “never deploy” do not block an accidental Wrangler deploy from this directory. No deployment was attempted.

Remedy: add a fail-closed guard allowing documented local execution while rejecting ordinary deploy/version-upload paths, and ensure a remote instance refuses fixture issuance/RPCs without a local-only capability. Verify without uploading. Preserve workspace/import isolation. Public local issuance is deliberate and is not itself an authentication defect.

## Executed evidence

Installed both locked dependency sets with `bun install --frozen-lockfile`. Ran Wrangler 4.153.0 locally on port 18987 with disposable `.review-state`; stopped it and removed review-only probe/state afterwards.

- `bun run check.ts`: passed. DOM undefined; both conversion paths returned `# Heading\n\nHello **world**.`; both text replicas returned `hello human agent world`; snapshot 5,242,900 bytes, 41 chunks, one update row, restored length 5,242,884.
- `bun run browser-test.ts`: passed in two isolated Chromium contexts. Starts increased from 1 to 2 over 15 seconds with two sockets retained; edits converged after idle. Agent awareness reached both contexts. Signed-name overwrite and other-client-ID rejection passed before/after idle. Replay, artifact mismatch, expiry and signature tampering returned 403. Read-only update did not reach peer. Revoke returned 1, closed its target and left the other client connected.
- Root `bun run check`: passed after dependency installation: Biome checked 1,485 files, nine Turbo tasks succeeded (eight cached), boundary lint clean. The pre-install attempt failed because Ultracite was unavailable, a setup issue. The standalone fixture has no dedicated TypeScript check script.

The constructor increase with retained sockets and post-idle convergence supports local hibernation under Cloudflare's documented lifecycle; staging was not tested. Installed y-partyserver confirms null-origin awareness uses its broadcast path. Claims survive via attachments. The interceptor rejects other-client IDs, multi-entry/trailing data and replaces identity from claims. Cursor accepts a nonnegative safe integer, not a document-relative bound. Agent allocation avoids current SQL owners; repeated agent lifetime/collision cases are not comprehensively tested.

Conversion proves StarterKit and one simple input inside workerd, not the full future schema, tables, sanitisation or hostile Markdown. The 5 MiB check genuinely writes/readbacks SQL chunks and an update row, but reconstructs in the same RPC; it does not establish recovery after eviction/crash or compaction atomicity. These limits are accurately documented.

Ticket verification binds artifact, expiry, identity, role and client ID. transactionSync atomically reserves client ID and consumes jti. Implementation and local replay checks support single use; simultaneous replay and restart recovery remain untested. Targeted revoke proves one socket for one participant, not multi-socket revocation or renewal following revoke.

## Explicitly deferred work

L.3 owns connection expiry/renewal, abandoned reservation recovery, production issuance/RPC authorization, private signing keys, rate limits, snapshot generations/compaction/recovery, size caps and agent presence lifetime/republishing. Those production implementations do not block this throwaway spike. L.2 owns complete schema/corpus/sanitisation and structural editor convergence; staging acceptance remains later work. Findings above concern missing L.0 evidence, a concrete negative result requiring a decision, and containing the deliberately unauthenticated fixture.


## Resolution evidence — 2026-10-27

- Two Chromium replicas captured a Yjs relative position before a queued, unmerged human insertion. The room inserted the agent contribution before release of the queued update; both converged to `agent human hello`. This tests Y.Text rather than full ProseMirror structure.
- The retained regression sends a high clock for the sender's own ID, cleanly disconnects, reconnects with a fresh ticket and the same ID, and observes suppression. A distinct ID is visible. The chosen L.3 strategy is connection-unique IDs, with non-reuse and lifecycle enforcement still required; clearing only server metadata cannot reset peers.
- The config's build hook rejects `wrangler deploy --dry-run` and `wrangler versions upload --dry-run` before uploading. Explicit local dev succeeds. A separate local run without the capability returned 403 for issuer, insert, agent, revoke and room routes. The capability is deliberately local setup, not production authentication; guard bypass or deliberately provisioning it remotely is outside the accidental-command protection.
- `check.ts` and `browser-test.ts` passed on fresh local state; the browser run reported two retained sockets, starts 1 to 2, both insert contributions, same-ID suppression and distinct-ID visibility. No remote deployment was attempted.

## Independent remediation re-review — 2026-10-27

Verdict: **approved for the three bounded L.0 remediation items**. Reviewed `16dd4eee` and `b7014997` on branch `t3/3d3e1c4c`; no new must-fix findings within this re-review. This verdict does not expand the original review to other spike concerns.

- **Concurrent relative insert:** `scripts/spikes/live-artifacts/browser-test.ts:62` captures a browser relative position, queues an unmerged human insertion, invokes the room insertion and reconnects. Both browser replicas converged to `agent human hello` in this run. This exercises Y.Text, not the future rich-editor binding.
- **Own-clock reconnect:** `scripts/spikes/live-artifacts/browser-test.ts:158` sends the sender's own high clock, closes, reconnects with the same ID and confirms suppression, then confirms a distinct ID is visible. `docs/v3/live-spike.md` records the negative result and chooses connection-unique IDs. L.3 still must enforce non-reuse and lifecycle cleanup; the spike does not implement that production fallback.
- **Local-only guard:** `scripts/spikes/live-artifacts/local-build.ts:3` allows explicit local Wrangler dev and rejects ordinary deployment builds; `worker.ts:357` denies HTTP routes without the separate capability. Wrangler 4.153.0 `deploy --dry-run` and `versions upload --dry-run` both failed in the build hook before upload. A local run without the capability returned 403 for ticket, insert, agent, revoke and room routes. This protects against ordinary accidental commands, not deliberate guard removal or remote provisioning of the capability.

Fresh local fixture state: `bun run check.ts` and `bun run browser-test.ts` passed; two sockets remained while starts rose from 1 to 2, both insert contributions converged, same-ID replacement was suppressed and distinct-ID replacement visible. No remote deployment was attempted. Read CLAUDE.md and the Cloudflare, Durable Objects and Wrangler skills. Removed disposable local fixture state after testing.
