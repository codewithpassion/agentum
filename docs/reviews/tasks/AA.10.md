# AA.10 review record

Staging check of agent connections on real Workers. Branch `task/AA.10-staging-check`.

Staging was Worker version ddcbcbc9, built from main before the gate 1 fixes (AA.11 to AA.13). The known gaps in `docs/reviews/AA-1.md` are not findings here.

## How it ran

Signed in with `bun run agent-login --env staging` and drove the page with agent-browser (system Chrome headless). The outside client was `@a2a-js/sdk` 1.3.0 from a local script, over real HTTPS, with an access key made in the page. Two throwaway agents on the cloud (Cloudflare) runtime, "AA10 check agent" and "AA10 second agent". Nothing else on staging was touched. The Dev Workspace was the only workspace the dev user could reach.

## Steps

| Step | Result |
|---|---|
| Publish the agent, make an access key, fetch the card over HTTPS, validate it with `@repo/a2a` | Passed. Card answered 200 `application/json`, `agentCardSchema` accepted it. JSONRPC and HTTP+JSON interfaces on `/a2a/<publicId>/rpc` and `/rest`, `streaming` and `pushNotifications` true, bearer scheme |
| SDK sends a message, it waits in Needs you, approve in the browser, task reaches a final state | Passed. `SendMessage` answered `TASK_STATE_AUTH_REQUIRED` with the waiting text in 257 ms. The item showed in Needs you with the full text and Approve and Decline. After Approve the task went `SUBMITTED`, `WORKING`, `COMPLETED` with artifact text "Pong." |
| Real model run | Yes. The workspace has an Anthropic and an OpenRouter key on staging. The run used the cloud runtime and a real model (no `faux`, which is dev only) |
| `auto`: blocking call returns, streaming works through Cloudflare | Passed on both bindings. Blocking `SendMessage` returned `COMPLETED` "Pong." in 10 to 11 seconds. `SendStreamingMessage` delivered events spread over the run (task at 1.9 s, `WORKING` at 3.9 s, artifact and `COMPLETED` at 5.9 s on JSONRPC, the same on HTTP+JSON), so the response was not buffered |
| "Accept pairing requests" on, code from a made-up token, enter it, see the token work, turn it off | Passed. A 41 character made-up token got HTTP 200 and a `TASK_STATE_REJECTED` task with an 8 character code and "Nothing was delivered". Entered with a label, the connection showed Active, and the same token's next `SendMessage` answered `AUTH_REQUIRED` (default `approve` policy). With pairing off, a new made-up token got 401 |
| Create an invite and join it from a second agent | Failed, then not run past the join. See "Defect" below. The join request reached the inviter inside the Worker (the in-process dispatch worked: the Worker answered its own `/a2a/pair/join` and the route ran the service), and the inviter refused with 400 "An agent cannot connect to another agent in its own workspace". Both agents are in the one workspace staging has, and the guard is by design. Approve, activate and the `active` state were not run, because that needs a second workspace, and the dev user can reach only one. Browser saw `POST /api/trpc/a2a.joinWithLink` answer 500 "Internal server error" |
| Revoke every connection, next call refused with 401 | Passed. Three connections (outside client, paired client, the open invite) revoked in the page with the confirm. Both tokens then got 401 on `ListTasks` (JSON-RPC and REST) and `SendMessage`. The paired client's message that was waiting for approval left Needs you on revoke |
| An `hm_a2a_` key fails at `/mcp` | Passed. `POST /mcp` with the active key answered 401 (`WWW-Authenticate: Bearer realm="harbourmaster", resource_metadata=...`), and again after revoke. `/api/proxy` answered 405 to a GET and was not tested further |
| `/a2a` routes answer without Clerk redirects | Passed. With a browser-style `Accept` and user agent and no token: card of an unknown id 404 JSON, `/rpc`, `/rest` and `/pair/join` 401 JSON, unknown path 404 JSON. No `Location` header on any |
| Page at desktop and at 375 px | Passed. Read at 1280, 1440 and 375 px wide, list and detail page. No horizontal overflow at 1440 or 375. At 1280 with the rail open the list table is a little wider than its pane and scrolls sideways, which cuts the first column until it is scrolled. Not a defect, noted |

## Defect

`joinWithLink` hid every refusal from the inviter. `createPairingTransport.join` threw a plain `Error("Peer join answered with status 400")` for any non-2xx answer, which tRPC turns into a 500, so the person saw "Internal server error" instead of "An agent cannot connect to another agent in its own workspace" (or "invite not valid", a full or expired invite). Fixed in `apps/web/src/server/a2a-transport.ts`: a 4xx answer with a JSON `error` text becomes `ServiceError("invalid", "The inviter refused: <text>")`, text cut to 200 characters and dropped if it holds the invite. 5xx and non-JSON answers stay a plain error with nothing from the peer in the message. Two tests added in `a2a-transport.test.ts`. The fix is not on staging, so the page there still shows the 500.

## Cleanup on staging

All three connections revoked. Pairing turned off. Both throwaway agents archived, and the card of the first answers 404. The invite was never used, and was revoked with the rest. Nothing else was changed. The first throwaway agent was made on the managed runtime and could not be published ("Agents on the managed runtime can't be published yet"), so it was archived and remade on the cloud runtime. `wrangler tail` (read only) was used once to read the join error.
