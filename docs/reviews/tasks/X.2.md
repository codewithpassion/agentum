# X.2 review

## Rounds

Round 1, at 28ab631: must-fix, two items. A connected OAuth app with write access could use `/api/desk` and answer approvals. And any signed-in member can mint a desk key and act as another member (below). The first is fixed in 7dbae0e: the desk routes take `hm_key_` keys only, a Clerk OAuth token answers 401 and is never sent to Clerk (so it cannot register a client either), and `actingMember` refuses anything but a desk key. The second needs Dom's decision. The same round fixed a nit: `decide` asks the requests service about visibility before it reads the body, so another member's private request is a 404 and not a 400.

Round 2, at 7dbae0e (fix commit only): clean.

## What was built

Three routes under `/api/desk`, outside the cookie group, all thin over the requests and runs services. The new service is `@repo/services/desk-api`. The stream route is X.6's.

- `GET /needs-you` lists the member's pending requests as C4 gives them. `agent` is the agent's name. For an approval, `title` is the stored summary and `detail` the scrubbed input. For a question, `title` is the first question's header (else its text) and `detail` lists the questions with their choices. Requests past `expiresAt` are left out even if the minute sweep has not closed them yet.
- `POST /requests/:id/decision` takes `{ decision, answer? }`. `always` becomes `always_allow`, and `answer` is the approval note. It answers `{ requestId, status: "answered" }`, which C4 leaves open. The answer goes through `requests.answer` with `via: "web"`, so the acting member is the decider, the first answer wins (a second one is 409), and `always` writes the tool rule. A read-only key principal is refused.
- `POST /controller/messages` takes `{ text, threadId? }` and answers `{ runId, sessionId }`. The same `threadId` continues the same session. The session has origin `ui`, so it is private to the acting member.
- Auth: an `hm_key_` key with the new `desk` access plus `X-On-Behalf-Of`. The server asks Clerk for the user with that email, accepts only a verified address with exactly one match, and checks that user belongs to the key's workspace organisation (`mcp/clerk-email-member.ts`). A missing header, unknown email or non-member is 403. No credential is 401. A read or write key is 403.
- `/mcp` answers 403 to a desk key. Connected apps (OAuth clients) stay read or write: `OAUTH_CLIENT_ACCESS` in `@repo/db/shared`.
- The principal resolver moved out of `routes/mcp.ts` into `mcp/principal-resolver.ts` so both routes share it. `/mcp` behaves as before.

## For the coordinator to confirm

- The controller agent is the active agent whose name is `controller`, case-insensitive. No match is a 404. Nothing makes agent names unique, so with two such agents the first in the list wins.
- A question request takes one `answer` string, so only a request with one question can be answered here. A question with several answers is a 400 ("answer it in Harbourmaster"). `deny` on a question records "Declined." when no answer is given. `allow_once` and `always` on a question need an answer.
- C4 says a Clerk OAuth token is accepted on the same routes once both apps share one Clerk instance (X.1). X.1 is done, but accepting every approved MCP app's token would let Claude Desktop answer approvals. This task refuses OAuth tokens until there is a way to tell flightdex's client from the rest (a named client id, or a `desk` access on an OAuth client). Say which you want.
- Decisions made here are stored with `via: "web"`. A distinct value would need an `ANSWER_SURFACES` change. The `desk.request` log line (key id, key owner, acting user) is the audit trail for now.
- No migration: `api_keys.access` is a text column and its enum is not a SQL constraint. `bun run generate` reports no schema change.

## Nits left

- `decide` reads the request twice (once for visibility, once for its kind and display).
- Every desk request asks Clerk for the user by email. Only the membership answer is cached. A client that polls `needs-you` costs one Clerk call per poll.
- Several active agents named `controller` are not an error.
- A decision on a request past `expiresAt` still works until the minute sweep closes it. The web does the same.

## Beyond the scope

- A cache for the email lookup, if flightdex polls often.
- A `desk` value in `ANSWER_SURFACES` so the Log can tell desk decisions from web ones.
- Restrict who can mint a desk key once Harbourmaster has an admin role.

## Steps for Dom

1. Decide the risk below. Any member of the workspace can mint a `desk` key in Settings > API keys. Holding one, they can act as any other member by email: read that member's pending requests (private UI sessions included), answer them with the other member recorded as the decider, and start controller runs as them. Harbourmaster has no admin role, so nothing limits this. The task asked for the scope next to read and write, so it is built that way. Mint desk keys yourself only, and tell members not to.
2. Deploy, then mint a `desk` key for flightdex in Settings > API keys. Store it as a flightdex Worker secret.
3. Create an agent named `controller` in the workspace, or messages answer 404.
4. Check on staging: `curl` each route with the key and `X-On-Behalf-Of: <your email>`. `GET /api/desk/needs-you` should answer `[]` or your pending items, `POST /api/desk/controller/messages` with `{"text":"hi"}` should answer `{runId, sessionId}`, and a decision should answer `{requestId, status}`.
