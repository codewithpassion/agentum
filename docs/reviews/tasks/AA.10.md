# AA.10 review record

Staging check of agent connections on real Workers. Branch `task/AA.10-staging-check`.

Staging was Worker version ddcbcbc9, built from main before the gate 1 fixes (AA.11 to AA.13). The known gaps in `docs/reviews/AA-1.md` are not findings here.

## How it ran

Signed in with `bun run agent-login --env staging` and drove the page with agent-browser (system Chrome headless). The outside client was `@a2a-js/sdk` 1.3.0 from a local script, over real HTTPS, with an access key made in the page. Two throwaway agents on the cloud (Cloudflare) runtime, "AA10 check agent" and "AA10 second agent". A first one made on the managed runtime could not be published and was archived unused. Nothing else on staging was touched. The Dev Workspace was the only workspace the dev user could reach. Another workspace would need a second Clerk organisation in `ALLOWED_ORG_IDS` on staging, which is a Worker setting and not this task's to change.

## Steps

| Step | Result |
|---|---|
| Publish the agent, make an access key, fetch the card over HTTPS, validate it with `@repo/a2a` | Passed. Card answered 200 `application/json`, `agentCardSchema` accepted it. JSONRPC and HTTP+JSON interfaces on `/a2a/<publicId>/rpc` and `/rest`, `streaming` and `pushNotifications` true, bearer scheme |
| SDK sends a message, it waits in Needs you, approve in the browser, task reaches a final state | Passed. `SendMessage` answered `TASK_STATE_AUTH_REQUIRED` with the waiting text in 257 ms. The item showed in Needs you with the full text and Approve and Decline. After Approve the task went `SUBMITTED`, `WORKING`, `COMPLETED` with artifact text "Pong." |
| Real model run | Yes. The workspace has an Anthropic and an OpenRouter key on staging. The run used the cloud runtime and a real model (no `faux`, which is dev only) |
| `auto`: blocking call returns, streaming works through Cloudflare | Passed on both bindings. Blocking `SendMessage` returned `COMPLETED` "Pong." in 10 to 11 seconds. `SendStreamingMessage` delivered events spread over the run (task at 1.9 s, `WORKING` at 3.9 s, artifact and `COMPLETED` at 5.9 s on JSONRPC, the same on HTTP+JSON), so the response was not buffered |
| "Accept pairing requests" on, code from a made-up token, enter it, see the token work, turn it off | Passed. A 41 character made-up token got HTTP 200 and a `TASK_STATE_REJECTED` task with an 8 character code and "Nothing was delivered". Entered with a label, the connection showed Active, and the same token's next `SendMessage` answered `AUTH_REQUIRED` (default `approve` policy). With pairing off, a new made-up token got 401 |
| Create an invite and join it from a second agent | Failed at the join, and not run past it. The join request reached the inviter inside the Worker, so the in-process path to `/a2a/pair/join` ran (a Worker cannot fetch its own hostname, and no network error came back). `wrangler tail` showed the joiner got HTTP 400 from the inviter. The reason is inferred from the code and was not read from the response: `vetPeer` refuses a peer in the joiner's own workspace with "An agent cannot connect to another agent in its own workspace", both agents are in the Dev Workspace, and the body was well formed. Browser saw `POST /api/trpc/a2a.joinWithLink` answer 500 "Internal server error". A successful join, the inviter's approval, the activation through the outbox and the `active` state were not run on a real Worker, and need a second workspace on staging. Follow-up for the controller |
| Revoke every connection, next call refused with 401 | Passed. Three connections (outside client, paired client, the open invite) revoked in the page with the confirm. Both tokens then got 401 on `ListTasks` (JSON-RPC and REST) and `SendMessage`. The paired client's message that was waiting for approval left Needs you on revoke |
| An `hm_a2a_` key fails at `/mcp` | Passed. `POST /mcp` with the active key answered 401 (`WWW-Authenticate: Bearer realm="harbourmaster", resource_metadata=...`), and again after revoke. `/api/proxy` answered 405 to a GET and was not tested further |
| `/a2a` routes answer without Clerk redirects | Passed. With a browser-style `Accept` and user agent and no token: card of an unknown id 404 JSON, `/rpc`, `/rest` and `/pair/join` 401 JSON, unknown path 404 JSON. No `Location` header on any |
| Page at desktop and at 375 px | Passed. Read at 1280, 1440 and 375 px wide, list and detail page. No horizontal overflow at 1440 or 375. At 1280 with the rail open the list table is a little wider than its pane and scrolls sideways, which cuts the first column until it is scrolled. Noted, not fixed: the page stays usable by scrolling, and it is outside what this task changes |

## Defect

`joinWithLink` hid every refusal from the inviter. `createPairingTransport.join` threw a plain `Error("Peer join answered with status 400")` for any non-2xx answer, which tRPC turns into a 500, so the person saw "Internal server error" instead of "An agent cannot connect to another agent in its own workspace" (or "This invite is not valid.", for an expired, used or failed invite). Fixed in `apps/web/src/server/a2a-transport.ts`: a 4xx answer with a JSON `error` text becomes `ServiceError("invalid", "The inviter refused: <text>")`, read at most 4 KB, cut to 200 characters, and dropped if the whole text holds the invite or the joiner's new token. 5xx and non-JSON answers stay a plain error with nothing from the peer in the message. Tests in `a2a-transport.test.ts` cover the text, a secret past the cut, the cut and a 4xx with no text. The fix is not on staging, so the page there still shows the 500.

## Cleanup on staging

All three connections revoked. Pairing turned off. Both throwaway agents archived, and the card of "AA10 check agent", the one published and used for the key, answers 404. The second agent was published inside the failed join dialog and archived, and its card was not fetched afterwards. The invite was never used, and was revoked with the rest. Nothing else was changed. The first throwaway agent was made on the managed runtime and could not be published ("Agents on the managed runtime can't be published yet"), so it was archived and remade on the cloud runtime. `wrangler tail` (read only) was used once to read the join error.

## Review

- Round 1, at 1be65288: not clean, 2 must-fix. The invite filter ran after the 200 character cut, so a token across the cut got through. The record gave the inviter's refusal text as observed when it was inferred from the code. Fixed in eb83d3c8 (whole text checked, joiner token too, body read bounded to 4 KB, tests, the record reworded).
- Round 2, at eb83d3c8: clean. Nits left: no test for a refusal body over 4 KB, the cut test's length bound is loose, `readBounded` says "Agent card" in its error and does not cancel the body when `content-length` is over the limit, `join-dialog.tsx` has no `break-words` on the error line (a 200 character unbroken text could scroll sideways at 375 px), and the `PairingTransport.join` doc does not mention that a refusal rejects with a `ServiceError`.

`bun run check`, `bun run test` and `bun run build` pass at eb83d3c8 with no `drizzle` in `apps/web/dist/client`. The workerd `guest execution` test timed out once in a full run and passed alone and in the later full run.

## For the controller

The join, approve and activate cycle on a real Worker is not covered. It needs a second workspace on staging (a second Clerk organisation in `ALLOWED_ORG_IDS`), because an agent cannot connect to another agent in its own workspace. The fix here is not on staging until the next deploy.
