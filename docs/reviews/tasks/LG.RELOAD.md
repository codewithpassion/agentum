# LG.RELOAD — queued rotating response during navigation

Investigated current main `e2e641f5`, including the independent LG.6 reports, `46af2f48`, identity isolation `d94db218`, and the original `ask-browser-runner.mjs:270` retry-after-reload assertion. No schema or product auth checks changed. The identity-scoped pending-ask implementation remains intact.

## Cause and scope

The fixture's old reload helper acquired `harbourmaster-guest-cookie`, called `location.reload()`, and returned from the lock callback. Requesting navigation does not synchronously destroy the document. The callback therefore released the lock while the old document could still admit queued guest requests. Transcript polling, readiness and other HTTP operations share that lock. A request admitted in this interval can commit the database token rotation and lose its response headers when navigation destroys its caller. The new document then sends the old HttpOnly cookie and is correctly refused. Draining one handshake did not drain or suspend the queue.

Inspected `GuestHttp.run/json/response`, transcript stream handshake and disposal, guest routes, session lifecycle and atomic rotation guards. JSON consumption and refused-body disposal occur under the lock; SSE releases it only after headers, with ongoing access checked using the stable server reference. The database rotation is conditional on the current token, role, grant expiry and live session. These checks must continue rejecting the interrupted request's obsolete credential. This reproduction does not implicate DO storage eviction or a saved-ask identity change.

## Deterministic evidence

The expanded production-assets execution runner retains every existing product reload/retry/role/replay/identity assertion and adds a disposable real-session experiment. A static same-origin document removes application polling timing from the causal experiment. It queues a real guest readiness request immediately behind the navigation lock. For the original helper, document delivery waits until the queued request commits its real server response; delivery of that request's headers waits until document destruction. The request is then aborted. This bounds and forces the delayed-response/navigation ordering rather than retrying the matrix until it passes.

The held request goes through `runtime.dispatchFetch` with the actual intercepted request headers. Using `route.fetch()` here would install its Set-Cookie in Playwright's shared APIRequestContext before browser response delivery and defeat the experiment. No cookie, token, OTP, request/response body, prompt or other secret is logged. Evidence includes only phase, request count and HTTP status. Both variants use the same current authenticated guest/session and actual production routes.

Observed: retained lock admits zero queued requests and subsequent open returns 200. Original helper admits exactly one queued request whose response is 200 with a Set-Cookie header; subsequent open returns 404. Returning to the actual product then renders “This invite has ended.” This is a negative control expected to fail authentication, with no assertion weakened or retry loop added. Historical logs lack per-request lifecycle traces, so they cannot retrospectively prove that every recorded failure followed this ordering.

## Fix and limits

The fixture now holds its navigation lock until Chromium destroys the old document, preventing queue admission in the navigation gap. Its callback intentionally remains pending after requesting navigation; `page.evaluate` itself returns immediately, and the separate bounded navigation wait verifies completion. The same helper covers reload and the identity-switch artifact navigation. Outstanding SSE bodies do not hold the cookie lock.

This fixes the proven defect in the fixture's purported lock-drained reload. It does **not** promise survival of an arbitrary browser/OS termination or external reload while a one-use credential response is already in flight. An interrupted committed rotation still invalidates the old credential by design. General recovery from that case would require a separately coordinated auth protocol design; replay windows, current-grant/role checks, and HttpOnly rotation were not relaxed to conceal it. No product change is justified by this controlled fixture cause alone.

## Validation

- Root `bun run build`: 5/5 tasks passed; existing Vite sourcemap warning.
- Focused HTTP, pending-ask, stream and session lifecycle tests: 20 passed, zero failures, 1,104 assertions.
- Expanded sequential actual production-assets execution matrix: 107 checks passed (the existing 102 plus five causal-probe assertions). One run, with both the passing retained-lock case and failing original-helper control in that same run.
- Root `bun run check`: lint passed (1,774 files); 11/12 typecheck tasks passed, web typecheck failed because default generated `Env` lacks existing secret/dev binding declarations (including `ARTIFACT_VIEW_KEY`, `RUN_TOKEN_KEY`, `SECRETS_KEY`, `ALLOWED_ORG_IDS` and `DEV_LOGIN_EMAIL`). No environment input changed to obtain a passing rerun. The chained boundary stage was consequently skipped; a separate `bun scripts/boundary-lint.ts` passed. `git diff --check` passed.

Logs: `/tmp/lg-reload-{install,build,browser,focused,check,boundary}.log`. Read Cloudflare and Durable Objects skills and the current Cloudflare rules documentation. No provider execution, real sends, environment/key changes, deployment, push, PR or subagents.

## Controller handoff

The reproducible original-helper navigation gap is fixed and covered by the permanent negative control. Do not describe general real-browser abrupt reload/session recovery as complete. The remaining product gap is a navigation or termination that interrupts an already committed rotating response before its HttpOnly cookie reaches the browser. The server has only the replacement token hash; the client retains an invalidated cookie. Recovering that case without broadening replay acceptance needs a coordinated protocol design and security review (and controller coordination before any schema change). No such protocol change is included here. The old independent logs alone cannot identify whether this or another ordering occurred in each historical run.
