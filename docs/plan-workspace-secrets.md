# Workspace secrets — implementation plan

## Goal

A workspace owner can store an API key for an external service (Deepgram, say),
grant it to specific agents, and those agents can use it without ever holding
the value. The key is write-only after it is set, usable on both runtimes, and
every use is scoped to the hosts the owner allowed for it.

Terminology: a **secret** is one named credential in a workspace
(`DEEPGRAM_API_KEY`). It is granted to agents the way connectors and skills
are.

## What we are not doing, and why

- **Not Cloudflare Secrets Store.** Account-level, one store, 100 secrets per
  account, bound at deploy time. Right for the deployment's own secrets
  (`CONNECTOR_KEY`, Clerk), wrong for per-workspace keys users paste in.
- **Not per-tenant KMS keys.** Cryptographic tenant isolation is an AWS-scale
  pattern; here every tenant's secret and the master key live in the same
  Worker environment anyway. Envelope encryption under `CONNECTOR_KEY` with
  the row bound in as additional data (see §2) is the honest level of
  isolation we can offer.
- **Not exposing the value to the model, ever.** Not as an env var in a
  transcript, not in a tool result, not in an error message. The design
  choices below all follow from this one rule, which is the one every
  credential-broker design converges on (Anthropic vaults, Cloudflare Outbound
  Workers, Infisical Agent Proxy, the CB4A draft).

## Locked design decisions

1. **Storage**: new module `modules/secrets` with two tables in its own
   `schema.ts`, following the module-isolation convention (plain `workspace_id`,
   no foreign keys to other modules):

   `workspace_secrets`
   - `id` text PK
   - `workspace_id` text not null
   - `name` text not null — env-var style, `^[A-Z][A-Z0-9_]{1,63}$`; unique
     within the workspace (`(workspace_id, name)` unique index)
   - `value_enc` text not null — AES-GCM ciphertext (see §2)
   - `key_version` integer not null default 1 — which `CONNECTOR_KEY` encrypted
     it (see §2, rotation)
   - `hint` text not null — last 4 characters, computed at write time
   - `allowed_hosts` text (json) not null — `string[]`, exact hostnames or
     `*.example.com`; empty means "nowhere", never "anywhere"
   - `header` text not null default `Authorization` — the request header the
     value is injected into
   - `header_prefix` text not null default `Bearer ` — what precedes the value
     (`Token ` for Deepgram, empty for `x-api-key`-style headers)
   - `description` text not null default `''` — shown to agents so they know
     what the secret is for
   - `set_by_clerk_user_id` text not null — audit only, never serialized
   - `last_used_at` integer nullable — updated by the tool (§4)
   - `created_at` / `updated_at` — existing column idioms

   `agent_secrets` — `(id, agent_id, secret_id, created_at)` with a unique
   `(agent_id, secret_id)` pair, mirroring `agent_connectors`.

   No cap on secrets per workspace for now; the vault mirror (§5) has a cap of
   20 credentials per vault, which is where a limit would bite first. Past it,
   the overflow secrets get `sync_status: "error"` naming the cap (as
   `composeAgentConnectors` reports dropped connectors); the tool path (§4) is
   unaffected, so those secrets still work everywhere except a managed
   agent's sandbox.

2. **Encryption**: `encryptSecret`/`decryptSecret` from `src/crypto.ts`,
   extended with an optional `additionalData` parameter passed to AES-GCM as
   AAD. Secrets bind `${workspaceId}:${secretId}` so a ciphertext copied into
   another row, or another tenant's row, fails to decrypt. Existing callers pass
   nothing and stay byte-compatible. `key_version` exists so `CONNECTOR_KEY`
   can be rotated later by a script that decrypts with the old key and
   re-encrypts with the new one; no rotation tooling in this phase, only the
   column.

3. **Write-only**: the value is decrypted in exactly two places, both
   server-side and neither a route handler: the tool executor (§4) and the vault
   mirror (§5). Responses carry `hint`, never the value. Error messages never
   include it. Follow `workspace-keys.ts` for the shape.

4. **Delivery mechanism, both runtimes: a broker-shaped `http_request` tool**
   (`modules/mcp`). The agent names the secret; the tool injects it.

   ```
   http_request({
     url: string,            // https only
     method?: "GET"|"POST"|"PUT"|"PATCH"|"DELETE",
     headers?: Record<string,string>,
     body?: string,          // sent as-is; content-type comes from headers
     secret?: string,        // a granted secret's name, e.g. "DEEPGRAM_API_KEY"
   }) -> { status, headers (subset), body (capped), truncated }
   ```

   Rules, in order:
   - `url` must be `https:` and pass the browser module's private-address
     guard (`browser/rules.ts`: loopback, RFC1918, link-local, CGNAT refused).
     Reuse it; do not write a second one.
   - `secret` must be granted to the calling agent (`agent_secrets` join,
     workspace-scoped). An ungranted or nonexistent name reads exactly like
     one that never existed: "No secret named X is granted to you."
   - The target hostname must match one of the secret's `allowed_hosts`. A
     mismatch is refused *before* any request is made, naming the allowed
     hosts so the agent can correct itself.
   - The tool sets `<header>: <header_prefix><value>`; an agent-supplied header
     of the same name is ignored. The agent cannot ask for the value in any
     other position (no body substitution, no query params) — header-only is
     the narrower surface, and the reason Anthropic's console defaults to it.
   - Response bodies are truncated with `truncateText`/`withTruncationNote`
     at `TOOL_OUTPUT_MAX_BYTES`, like `computer_exec`.
   - **Redaction**: before the result is returned, every occurrence of the
     secret's value in the response body and headers is replaced with
     `[REDACTED:<name>]`. A misbehaving upstream that echoes the key must not
     put it in the transcript, the runner's events, or the activity feed.
   - The call is logged with `logActivity` (`kind: "http_request"`, summary
     `METHOD host/path → status`, detail without headers or body), and
     `last_used_at` is bumped on the secret. That is the audit trail for "which
     agent used which key where".
   - Without `secret`, the tool is a plain HTTPS fetch with the same guards.
     **Decision needed:** that is a new capability for every agent —
     unauthenticated egress to any public host, reachable by prompt injection —
     and not a side effect of secrets. Options: (a) allow it, since the browser
     tools already give agents comparable reach; (b) require `secret`, so the
     tool only ever talks to allowlisted hosts. Default in this plan is (a);
     say if you want (b).

   One implementation serves both runtimes: managed agents reach it over MCP,
   Cloudflare agents in-process through the same server (`mcp/server.ts`).

5. **Vault mirror for managed agents** (`modules/anthropic`): each secret is
   also pushed as an `environment_variable` vault credential —
   `secret_name: name`, `networking: { type: "limited", allowed_hosts }`,
   `injection_location: { header: true }` — so a skill script in the sandbox
   can `curl -H "Authorization: Token $DEEPGRAM_API_KEY"` and get egress
   substitution from Anthropic. The D1 row is the source of truth; the vault
   credential is a mirror keyed by `secret_name`, exactly like connectors.

   Topology: **one vault per workspace for secrets** (`workspace_secret_vault`
   id cached in `app_config`, keyed like the environment id so a workspace on
   its own Anthropic key gets its own), not one per secret — vault ids attach
   at session create and `sessionVaultIdsFor` already dedupes. Session create
   adds that vault when the agent has any granted secret. Note vault
   credentials apply to every session that carries the vault, so the grant is
   enforced by whether the vault is attached at all, plus the tool's own
   check; a session with the vault attached can use every secret in it. That
   is acceptable for v1 and stated in the UI ("granted secrets are available
   to this agent's sandbox").

   Structural fields (`secret_name`) are immutable on Anthropic's side:
   renaming a secret archives the credential and creates a new one. Rotating
   the value or editing `allowed_hosts` is an update. Deleting the secret
   archives the credential. The key-change reset (`resetWorkspaceAnthropicResources`)
   nulls the mirror ids so the existing resync path recreates them, the same
   way it treats connectors.

   Mirror failures are recorded on the secret row (`sync_status`,
   `sync_error`, same three states as agents) and never block the save; the
   tool path (§4) works regardless.

6. **Cloudflare runtime shell (later, not this phase)**: when the agent
   computer's exec is production-viable, hand its Dynamic Worker a
   `globalOutbound` Fetcher that does the same host-match-and-inject from D1,
   and export `<name>=<opaque placeholder>` into the shell. Same table, same
   allowlist, a third injection point. Recorded here so the schema is not
   designed in a way that blocks it (it is not: everything the outbound hook
   needs is on the row).

7. **Grants**: `agent_secrets` rows, managed from the agent dialog like
   connectors. A grant takes effect on the agent's next tool call immediately
   (the tool reads the join) and on its next managed session for the vault
   mirror (vault ids attach at create; document this the way connector
   assignments already do).

8. **System prompt**: one bullet in `workspaceRules`, both runtimes: "Secrets
   you have been granted are listed by `list_secrets`; use them by passing
   `secret` to `http_request`. You will never see a secret's value, and you
   must not ask a person for one in chat." The sandbox sentence — "In your
   sandbox each granted secret is an environment variable of the same name
   that works only for its allowed hosts." — rides the existing `managed`
   branch of `composeSystemPrompt`; no third variant.

## API contract (mounted under `workspaceScopedRoutes` at `/secrets`)

Owner-gated for writes (`requireOwner`, as the Anthropic key is); any member may
list. Patterns from `workspaces/routes.ts` and `anthropic/routes.ts`.

- `GET /secrets` → `{ secrets: SecretView[] }` where `SecretView` is
  `{ id, name, hint, allowedHosts, header, headerPrefix, description, lastUsedAt, syncStatus, syncError, agentIds, createdAt, updatedAt }`.
  Never the value.
- `POST /secrets` — body `{ name, value, allowedHosts, header?, headerPrefix?, description? }`.
  Validates name shape, `allowedHosts` non-empty and each a hostname or
  `*.` wildcard (no schemes, no paths, no IPs in private ranges), value
  non-empty and ≤ 4 KB. Encrypts, inserts, kicks off the vault mirror in the
  background. 409 on a duplicate name. Response: `SecretView`, 201.
- `PATCH /secrets/:id` — any of `{ value, allowedHosts, header, headerPrefix, description }`.
  `name` is immutable (delete and recreate; the tool and the sandbox both key
  on it). A new value re-encrypts and rotates the mirror. Response: `SecretView`.
- `DELETE /secrets/:id` — deletes the row and its grants, archives the mirror.
  204.
- `PUT /secrets/:id/agents/:agentId` / `DELETE /secrets/:id/agents/:agentId`
  — grant / revoke. 404 for an agent of another workspace, indistinguishable
  from a missing one.

MCP tools (`modules/mcp/secret-tools.ts`, registered by `registerWorkspaceTools`):

- `list_secrets` → `{ secrets: [{ name, description, allowedHosts }] }` —
  only the caller's grants. No hints, no ids.
- `http_request` — §4.

## UI

- **Sidebar section "Secrets"** next to Connectors and Skills, owner-only
  actions: list with name, hint, allowed hosts, last used, sync dot (reuse
  `SkillSyncDot`); add dialog (name, value as a password field, hosts as a
  chip list, header/prefix under an "Advanced" disclosure with a Deepgram-style
  example); rotate (value only) and delete with a confirm.
- **Agent dialog, new "Secrets" tab** for both runtimes (unlike Connectors,
  which is managed-only), a checkbox list like `AgentConnectorsPicker`, with
  the note about when a grant takes effect.
- **Agent screen**: `http_request` rows in the activity feed, showing method,
  host and status — never headers or bodies.

## Work split

- **Forge 1 — backend core** (first, blocking): `modules/secrets` schema +
  migration (`0022_workspace_secrets`), `crypto.ts` AAD parameter (with a test
  that the old format still decrypts and that mismatched AAD fails), service
  (create/update/delete/grant/resolve-for-agent, decrypt in one function),
  routes, tests including the cross-tenant existence-oracle cases.
- **Forge 2 — the tool** (after 1): `http_request` + `list_secrets`, the host
  allowlist matcher (pure, tested: exact, wildcard, no suffix tricks like
  `evil-api.deepgram.com` matching `api.deepgram.com`), redaction (pure,
  tested), activity logging, system-prompt bullets. Integration test through
  the in-memory MCP client, like `runner/durable-object.test.ts`, with a
  stubbed `fetch`.
- **Forge 3 — vault mirror** (parallel with 2, disjoint files):
  `vaults.ts` gains `environment_variable` create/update/archive; per-workspace
  secrets vault in `app_config`; `sessionVaultIdsFor` includes it when the
  agent has grants; key-change reset; sync status on the row; tests against a
  fake vault gateway. Phase-entry spike first: create one `environment_variable`
  credential against the live API with `scripts/anthropic-spike.ts` and confirm
  the request shape and the 20-per-vault cap, since every payload in
  `vaults.ts` so far came from a spike.
- **Forge 4 — frontend** (after 1, parallel with 2 and 3): sidebar section,
  agent dialog tab, activity row, `api.ts` types.

Verification: `bun test` (targeted, then full), `bun x ultracite check`,
`bun run typecheck`, `bun run db:migrate:local` applies cleanly. Acceptance on
the dev server: store a real Deepgram key with `allowed_hosts:
["api.deepgram.com"]`, grant it to a Cloudflare-runtime agent, ask it to
transcribe a public audio URL, and confirm (a) the transcript never contains
the key, (b) the activity row shows `POST api.deepgram.com/v1/listen → 200`,
(c) the same ask against `api.example.com` is refused before any request.
Then the same on a managed agent through a `curl` in a skill.

## Risks

- **A secret that must be signed with, not sent** (SigV4, HMAC webhooks) does
  not fit header injection on either path. Out of scope; say so in the add
  dialog's help text.
- **Token-exchange flows** (client credentials → bearer) return a real token
  into the sandbox unredacted on the managed path. Same answer: exchange
  outside and store the resulting token.
- **Redaction is best-effort**: it catches the literal value, not an encoded
  or split one. The allowlist is the real control; redaction is the belt to
  its braces.
- **The vault is per workspace, grants are per agent** (§5). An owner who
  wants hard isolation between agents' sandbox credentials needs one vault per
  secret; revisit if it comes up.
