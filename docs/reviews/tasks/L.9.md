# L.9 — real agent thread, comments and change panels

**Current resumed status:** root namespace and service endpoints are merged; full-app acceptance is blocked before dev login by the cancelled local signing-key setup. The independent review fixes below are implemented and covered by client regressions.

`CollaborationPanel` is mounted in the actual document editor sidebar. Desktop uses a margin panel; phones use the existing bottom Sheet with focus trapping, Escape and focus return. It presents three surfaces: the shared agent thread, anchored comments and agent changes. There are no production fixture callbacks.

## Implemented behavior

- Agent choice calls `liveArtifacts.selectAgent` and preserves the artifact's shared session. Transcript history comes from `sessions.transcript`; the existing session SSE hook, protocol fold and thread components render actual messages, streaming text and trusted authors. Artifact messages always request author labels. The transcript links to the real run for approvals and other task actions.
- Ordinary thread asks call `liveArtifacts.ask` with `via: artifact_thread`. A saved editor selection opens the thread, republishes the relative cursor, waits for canonical room acknowledgement and calls the same service with `via: ask_agent`. Neither request supplies author, role, session, roster, selected text or a speaker envelope. The service resolves trusted room selection and sender identity.
- Comment creation calls `liveArtifacts.comment` with the selected Yjs-relative anchor. Replies, resolve and addressed-comment delivery retry call their actual service procedures. Addressed posts keep a stable request ID after a failed send; changing the draft makes a new request. Busy drafts cannot change underneath an in-flight request. Polling discovers a comment even when its durable commit succeeded but agent dispatch failed, providing the persisted-comment retry path.
- Comment records resolve against the current provider document on updates, show detachment, retain the service-derived quote and offer navigation back to the live relative range. Reply and resolve controls respect viewer/commenter/editor/owner roles. No persisted-comment retry control is inferred from thread state: the API currently supplies no per-comment dispatch status. Failed addressed drafts instead retry through their unchanged stable request ID.
- Agent changes display actual summaries, run links, time and original revert actor. Revert uses explicit confirmation and `liveArtifacts.revertChange`; the client never applies an old snapshot or performs a local substitute undo. Only editors/owners see mutation controls.
- Paginated comments/changes retain the number of pages explicitly requested and refresh those pages, so a periodic refresh cannot silently throw away loaded history. Loading, busy states, network/service errors and retry controls are visible.

## Verification and remaining acceptance gates

The real service/router request shapes are inferred from the existing router factory, with no unsafe root-router cast. Root check/test/build and the transport/editor browser evidence are described in `L.8.md`; these are not evidence that the collaboration panels have passed authenticated end-to-end acceptance.

`apps/web/e2e/live-artifacts.ts` drives the real app without network interception: two browser profiles at both required viewports, document creation, initial content, bidirectional edits/own undo, selection comments, peer visibility, reply/resolve, available real changes/revert and viewport bounds. It records actual-agent, distinct-member and staging gates explicitly. Its first authenticated run reached the missing `liveArtifacts.createDocument` procedure, so no downstream app interaction has yet been certified. L.7's mounted router/endpoints are the concrete blocking dependency.

The current `changes` API contains no authoritative relative changed ranges. L.7/controller were notified; no quote-based approximation or fabricated attribution was added. A real agent/runtime and second authorized member are required to certify all three ask surfaces' speaker envelopes and actual revert preservation. Staging is an external-auth/deployment gate owned by the controller. No task status files were edited in this lane; neither L.8 nor L.9 is asserted end-to-end complete here.

Integration-ready validation: root check/test/build pass; focused editor/provider suite is 38 tests with 198 assertions. Both component and actual workerd-room browser checks pass at the required desktop/phone sizes. The actual room check covers transport and presence, **not** shared-thread/comment/revert app interactions. Full L.9 authenticated acceptance still requires the L.7 mount, verified service endpoints, an actual agent change, and a second authorized member.

## Independent review — 2026-10-27

Reviewed merged client `4d852d19` at checkout `2e4ac2495a7bfcf608206512179f26c24ea00c76`. Verdict: **changes required**.

### Medium — retry controls are offered for replies that have no dispatch

`CommentThread` offers “Retry agent delivery” for every current user's comment in an unanswered addressed thread. Replies have `toAgent: false` and create no addressed-comment dispatch, while `retryCommentAsk` requires a dispatch for the specific comment ID. A user replying to such a thread sees a retry button that fails with the service's missing error. Show retry only for the original addressed comment with a retryable dispatch, ideally using an explicit server-provided delivery state rather than inferring it from thread state. The present control also appears after successful dispatch until answered; an idempotent service avoids a duplicate run but the UI misleadingly suggests a failure.

### Medium — selection context survives a successful ask

`AgentComposer` clears the text after sending but `CollaborationPanel` retains the selection and original ask intent. The next ordinary message therefore remains `via: ask_agent` and republishes the old selection unless the user explicitly clears it. Clear the attached selection on successful submission, or otherwise make its persistent attachment explicit. This is a client state-path finding, not a completed authenticated browser reproduction.

The panel uses actual typed service shapes, stable request IDs across unchanged failed addressed drafts, relative anchors and role-gated mutations; pagination reloads the requested number of pages. Comment author names fall back to raw kind/ID when the author is absent from current presence, so the roster is not a durable author directory. Shared transcript and panel behavior, speaker identity, anchored deletion, retries and revert still require authenticated full-app browser acceptance with two distinct members and a real agent. The L.7 root namespace and policy/upload/export/attribution integration is absent at this checkout; this is a separate integration gate, not a passing L.9 result. The passing 38 focused tests and two browser fixtures reported in L.8 do not exercise these panel flows. No product edits or preview tools were used.

Resumed against main `78fd83f8` / L.7 checkpoint `1f19b0e3`: the production router/endpoints now exist. Current authenticated full-app attempts encounter missing local `ARTIFACT_VIEW_KEY` during request composition, before the dev-login API can complete. Controller/L.7 were notified. The earlier absent-namespace gate is historical; thread/comments/revert acceptance has not yet run past this new configuration gate. No distinct second dev identity or actual agent change has been manufactured.

## Independent review remediation

- Removed the inferred retry button from every persisted comment, including ordinary replies and already delivered addressed comments. The thread response has no explicit retryable dispatch state, so the client does not invent one. Only an addressed draft whose actual POST failed offers **Retry agent delivery**, retaining the same request ID. Editing that draft or its address-agent choice clears the failure and creates a new request ID. A rendered addressed-thread regression includes an original comment plus ordinary reply and verifies neither gets an invented delivery-retry action.
- Successful asks now consume the selection attachment and clear the room cursor before refreshing the shared transcript. Explicit **Clear selection** does the same. The tested hook is used by the production panel's `onSent` callback; its rendered regression attaches a selection, processes a successful send and verifies the next message context is `artifact_thread` with no published cursor. A failed send never calls this completion callback, so its attachment remains available for retry.

The focused suite passes **41 tests / 214 assertions**. No actual shared-thread ask, address-agent run, comment/reply/resolve, upload/checkpoint or revert app interaction is claimed from these regressions. The extended no-interception E2E runner is ready, but `ARTIFACT_VIEW_KEY` remains absent and the controller's private card was cancelled without a value; no replacement key or auth bypass was introduced. Current merged-root lint/Bun-builder failures are detailed in L.8 and reported to L.7. Distinct-member, real-agent and staging gates remain explicit. Authoritative attribution is now wired from the L.7 follow-up below.

## L.7 follow-up integration

Main `18204b8e` includes `b729aadf`; the document client now validates and renders optional authoritative `policy.agentChanges` directly from accepted CRDT ranges. No range is synthesized from a comment quote, plain text match or revision number. The three independent review findings are fixed and covered by targeted provider/renderer/selection-state regressions; focused total **43 passed / 225 assertions**.

Current real-app acceptance still has **zero passed app interactions**: the authentic dev-login API returns 500 because local `ARTIFACT_VIEW_KEY` is unavailable. The private card was cancelled, and no generation, new prompt, callback substitute or auth bypass followed. The expanded runner includes real upload/manifest/peer fetch, Markdown export and checkpoint restore, alongside the existing selection-comment/reply/resolve and available-agent/revert checks; none of those app surfaces has been certified in this gated run. Actual workerd browser results certify transport/presence only. The latest merged root check/build pass, replacing the earlier server-lint failure; final root tests are reported separately after completion.

Final resumed root validation passes after the server follow-up: check **12/12**, tests **12/12** (web **3316 passed / 1 existing skip**, services **3144 passed**, root scripts **284 passed**), build **5/5**, clean boundary/bundle scans. The cancelled signing key still prevents the real app's dev-login endpoint from completing; actual member/thread/comment/revert acceptance remains open.

## Independent bounded recheck — 2026-10-27

Reviewed client `8b06aadb` in main `d983f853`. No new L.9 finding in this bounded recheck. Persisted comments and ordinary replies no longer receive inferred delivery-retry controls; only a failed addressed draft offers that action, with its request ID retained until the draft or address choice changes. Successful selection asks consume the attachment and clear the room cursor; failed asks retain it. The focused rendered and provider/policy tests passed **14 tests / 61 assertions**. Actual two-context room browser checks passed at desktop and phone sizes, but do not certify shared-thread, real-agent, comment/revert or Clerk-backed app flows. Full-app Clerk, distinct members, all runtime/agent paths and staging remain open gates. See L.7 for the separate recovery provenance finding.
