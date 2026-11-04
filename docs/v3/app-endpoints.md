# App endpoints and agent hand-off

Status: approved by Dom on 4 Nov 2026. Tasks EP.1 to EP.4.

## Why

Dom wants agents on Agentum to build bots, such as a Discord slash command bot, without a release of Agentum for each one. An app artifact can already ship server code (`server/index.js`, run as a Dynamic Worker) with approved hosts and proxy secret headers. Two pieces are missing:

1. A public address. Today the server part is reached only at `/a/<id>/c/<view token>/api/*`, and the token is short-lived and tied to a person or a share link. Discord, GitHub or Stripe can't call that.
2. A hand-off to an agent. The bot's code answers fast requests itself, and some requests need an LLM, which takes longer than a webhook caller waits (Discord: 3 seconds).

After this ships, a bot is an app artifact: data, made through the MCP tools, approved by a person in Needs you. No Agentum release is needed per bot.

## Rename first

The manifest is `agentum.json`, and app code reads the `env.AGENTUM` binding. Production has no app artifacts, so there is no fallback for the old names. The docs (`artifacts-prd.md`, `phase2-spike.md`) change with the code.

## Manifest

```json
{
  "hosts": ["discord.com"],
  "secrets": ["DISCORD_BOT_TOKEN"],
  "endpoints": [{ "name": "discord" }],
  "agents": [{ "agent": "<agent id>" }]
}
```

`endpoints` and `agents` need a `server/` part, as hosts and secrets do. Each entry becomes a grant row of a new kind, `endpoint` or `agent`, approved by a person with the version's other grants. An agent may ask; it can never open an endpoint or start an agent by itself.

## Endpoints

- Address: `https://<PUBLIC_BASE_URL>/hooks/<endpoint id>/<path>`. The id is random, 32 URL-safe characters. A row in `artifact_endpoints` (id, artifact_id, workspace_id, name, created_at, disabled_at) holds it. It is made when a version declaring that name is first approved, and it stays across versions.
- A request is served by the artifact's live version only when that version has an approved `endpoint` grant for the name. Otherwise 404. A disabled row also gives 404.
- A member can copy, disable, enable and rotate an endpoint in the artifact's settings. Rotating disables the row and makes a new one with a new id. Rotated-away addresses are history and are not listed in settings.
- The route is mounted like `/a2a`: before Clerk, never under `cookieGroup()` or `csrf()`.
- The app gets the request as sent: method, path after `/hooks/<id>`, query and the raw body unchanged, so it can check a signature. Request headers drop as today (cookie, `cf-*`, `x-forwarded-*` and the rest), except `authorization`, which an endpoint request keeps. Response headers go through the same allowlist.
- The viewer is `{ kind: "endpoint", endpointId }`. On it, `env.AGENTUM` allows:
  - shared storage, read and write;
  - `startRun` (below);
  - `whoami()`, which answers `viewer: "endpoint"`.

  It refuses viewer storage and `callTool`, because no person is behind the request. Outbound requests to approved hosts get approved proxy secret headers, as for a member.
- An IP-prefix-only guard is checked first, with a budget of 600 calls per minute across two fixed 300-call buckets on the existing limiter. Each endpoint also has a 300-call-per-minute limit, keyed by endpoint id plus IP prefix. An `artifact_views` row is written for each call that reaches the app; refused, unknown and rate-limited calls write none.

Decision, recorded in the PRD's risk table: an endpoint is open to anyone on the internet, and its requests can fill approved secrets on outbound requests. The app's own code authenticates its caller (Discord's Ed25519 signature, a GitHub HMAC, a shared secret). The approval card in Needs you says so in one sentence. The platform runs no verifier.

## Hand-off to an agent

`env.AGENTUM.startRun({ agent, text, state?, sessionKey? })` returns `{ runId }` at once and doesn't wait.

- `agent` must be the id of an approved `agent` grant on the live version. Approving that grant makes a tokenless trigger row for the agent, with a new nullable `triggers.artifact_id`, or reuses one. The run starts through the triggers service as that trigger principal, so it is on behalf of nobody, shows up under Triggers, and pausing or revoking that trigger stops the hand-off.
- `state` is an opaque string of at most 4096 characters, such as Discord's interaction token. It is stored on the reply target and handed back with the reply.
- `sessionKey` (optional, at most 169 characters) continues one session per key within the app’s trigger, for example a Discord channel. The session external key is `app:<triggerId>:<sessionKey>`, so apps never share conversations.
- Allowed on `endpoint` viewers only. Every other viewer is refused with `forbidden`.

The reply target is a new `ReplyTarget` kind `{ kind: "app", artifactId, state }`. An `app` gateway in `compose.ts` delivers it. It calls the live version's `reply` export, never `fetch`, with the viewer `{ kind: "reply", runId }`:

```js
export default {
  async fetch(request, env) { /* endpoint and page requests */ },
  async reply({ runId, status, text, fileIds, state }, env) { /* post the follow-up */ },
};
```

`status` is `finished`, `failed`, `cancelled` or `interrupted`. A finished run arrives through `deliverReply`, and the others through the runs event hook, the way `a2a/tasks.ts` follows them. A reply viewer has the same rights as an endpoint viewer minus `startRun`. A version without a `reply` export ignores replies. A failed delivery writes an `app.reply_failed` event and is not retried.

Delivery needs `env.LOADER` and the Worker's `ctx.exports`. `compose` gets an optional `exports` argument, and every caller that can finish a run passes it: the request handler in `server.ts`, `pi-run.ts`, `managed-poller.ts` and `vm-session.ts`. Without it, the app gateway writes `app.reply_failed`.

## MCP

The descriptions of the `app` kind, `artifact_create` and `artifact_promote` explain `agentum.json`, endpoints, `startRun` and the `reply` export. They also link an example, served as an MCP resource or in the tool description, of a Discord-style handler that:

- verifies an Ed25519 signature;
- answers PING;
- does one fast action itself;
- hands one request to an agent with the interaction token as `state`, and posts the follow-up in `reply`.

A bot needs no page. It ships a one-line `index.html`, and the descriptions say so.

### Building through MCP

A person gives `files` directly or uses `fromLibraryPath`. A run may build in
`agents/<slug>/tasks/<runId>/`. Use relative paths. `artifact_create` includes
the complete Discord example; `artifact_list` keeps only the short kind guide.
For both callers, a bot ships a one-line `index.html`, `server/index.js` and
`agentum.json`.

A run’s app version is proposed until `artifact_promote`. That call opens one
approval card listing all pending grants. Approval makes the version live.
A person’s app version is current immediately after `artifact_create` or
`artifact_update`. New grants wait in one card in Needs you for that current
version. One Approve decides them all. Approval activates its endpoints and
agent hand-off; no second `artifact_promote` is needed. `artifact_promote`
reports `waiting` while those grants are pending. `artifact_read` returns the
requested version’s grants with status `pending`, `approved` or `rejected`.

`agentum.json` accepts at most 5 endpoints and 5 agents. Endpoint names match
`^[a-z0-9-]{1,40}$`. `agents: [{"agent":"<agent id>"}]` takes the `id` from
`list_agents`, which returns both ids and slugs. If there are no agents, call
`create_agent` with its required `model`, or ask a person to create one.
Cloud model ids are `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`,
`openrouter:z-ai/glm-5.3`, `openrouter:z-ai/glm-5.3-flash`, and
`openrouter:deepseek/deepseek-v4.1-flash-1017`. Managed and machine runtimes
require an Anthropic model.

An endpoint may serve any HTTP method, including GET. Durable storage uses
`env.AGENTUM.getItem(area, key)`, `setItem(area, key, value)`,
`listItems(area, prefix?, limit?)` and `deleteItem(area, key)`. Use the `"shared"`
area in endpoint and reply code. Values are strings; encode structured values
with `JSON.stringify` and decode with `JSON.parse`. Module-level variables are
not durable across requests.

For proxy secrets, a person saves the secret and its host rule in Settings,
then approves the app’s host and secret grants. The platform sets the rule’s
header on requests to that host. The app writes no token. The Discord example
uses `DISCORD_BOT_TOKEN` with host `discord.com`, header `Authorization` and
template `Bot {value}`. Never put secret values in app files.

`artifact_test` requires write access because it saves a screenshot. It can
run before approval. Its test viewer can read shared storage, sees empty
viewer storage, and cannot write storage, call tools or start runs. Outbound
requests still require approved host and secret grants, so they may fail
before approval. It tests the page; send signed endpoint requests separately.

The `reply` status values are `finished`, `failed`, `cancelled`, `interrupted`.
In the Discord example, `sessionKey: channel_id` shares one agent session per
channel. `/role` requires a server member and returns a message in DMs.

## Out of scope

- Long-lived connections, such as Discord's gateway websocket.
- Background work after the response.
- A platform signature verifier.
- The `harbourmaster/<tool>` approval rule keys, a separate rename leftover.
