# Agentum — Connectors & Skills Plan

Two new capabilities on top of the Phase 1–3 workspace ([plan.md](plan.md)):

1. **Connectors** — user-added remote MCP servers (no preset catalog), with OAuth
   including token management and automatic refresh where the server supports it,
   assignable per agent.
2. **Skills** — a top-level, versioned skills directory; full skills with scripts;
   assigned to agents from the agent settings page; agents can author skills
   themselves and self-heal a broken skill by shipping a fixed version.

Both map directly onto native Managed Agents primitives (verified against the
Managed Agents beta docs, 2026-08-20) — we build management UX and glue, not a
refresh daemon or a skill loader:

- **MCP servers** are declared on the agent (`mcp_servers: [{type:"url", name, url}]`
  plus a matching `tools: [{type:"mcp_toolset", mcp_server_name}]`), with **no auth
  on the agent**. Credentials live in Anthropic **Vaults** (`mcp_oauth` /
  `static_bearer`, keyed by normalized `mcp_server_url`) attached at session create
  via `vault_ids`. Anthropic auto-refreshes `mcp_oauth` tokens via the credential's
  `refresh` block (`refresh_token`, `client_id`, `token_endpoint`,
  `token_endpoint_auth`). Limits: 20 `mcp_servers` per agent (unique names),
  20 credentials per vault, `vault_ids` is **session-create-only**.
- **Skills** are a first-class versioned API (`POST /v1/skills`,
  `POST /v1/skills/{id}/versions`, beta `skills-2025-10-02`) and are attached to the
  agent as `skills: [{type:"custom", skill_id, version}]`, `version` defaulting to
  `"latest"`. Limit: 20 skills per agent.
- Invalid vault credentials **don't block session creation** — they surface as
  `session.error` with auth retried on the next idle→running transition. That event
  is our hook for connector health status in the UI.

## Phase-entry spikes (verify against the live API before building)

Same convention as plan.md's environment-reuse spike — first task of each phase,
in `scripts/anthropic-spike.ts`:

1. **Skill version upload shape** — the exact payload for `POST /v1/skills` and
   `POST /v1/skills/{id}/versions` (multipart file upload is expected but not
   documented in our reference; confirm field names, SKILL.md validation errors,
   size limits, and what a version identifier looks like).
2. **`agents.update` accepts `skills`** — `mcp_servers` on update is already used
   by `syncAgent` and confirmed; verify the same partial-update-preserves-omitted
   semantics hold for `skills`.

## Decision needed: the name "connectors"

`modules/connectors` today is the **Slack channel bridge** (external chat surfaces
→ internal channels). The user-facing product name for remote MCP servers is
**Connectors**. Recommendation, in order:

1. **(Recommended)** Rename the Slack module to `modules/bridges` — that is what
   it does (its own tables are literally `channel_bridges`) — and give
   `modules/connectors` to MCP connectors. One mechanical rename commit, done
   before any new code.
2. Keep the Slack module as-is and put MCP connectors in `modules/mcp-connectors`
   — no churn, but the module named `connectors` is then *not* the Connectors
   feature, forever.

The rest of this plan assumes option 1.

---

## Phase 4 — Connectors (remote MCP with OAuth)

**Goal:** the user pastes any MCP server URL, completes OAuth in a popup if the
server requires it, assigns the connector to agents, and those agents' sessions
can call its tools — with token refresh handled automatically and connector
health visible in the UI.

### 4a. Data model (`modules/connectors`)

```
connectors
  id, name (display), url (canonical MCP endpoint), status
    (unconfigured | authorizing | connected | auth_error | disabled),
  auth_kind (none | oauth | bearer),
  vault_id, vault_credential_id            -- the Anthropic-side credential
  oauth_client_id, oauth_token_endpoint,   -- discovered/registered client info
  oauth_client_secret_enc,                 -- encrypted, confidential clients only
  mgmt_access_token_enc, mgmt_refresh_token_enc, mgmt_expires_at,
  last_error, tool_cache (JSON, last listed tools), created_at, updated_at

agent_connectors
  agent_id, connector_id, created_at       -- unique (agent_id, connector_id)
```

Encryption: a single `CONNECTOR_KEY` Worker secret, AES-GCM via WebCrypto —
tokens never stored in plaintext in D1.

**Two token stores, one source of truth each (this split is deliberate):**

- **Vault credential = source of truth for sessions.** Anthropic injects and
  auto-refreshes it; we never learn the refreshed token, and that's fine.
- **Encrypted D1 copy = management plane only** — used by the Worker to list the
  connector's tools for the UI and run "Test connection". Refreshed lazily on use.
  If the server rotates refresh tokens, Anthropic's refresh can invalidate our
  copy: the connector then shows "re-authorize for management features" while
  **agent sessions keep working untouched**. We never write our refreshed tokens
  back to the vault except on explicit re-auth (vault secret fields are updatable;
  key fields like `mcp_server_url` are immutable — changing the URL means archive
  + recreate the credential).

**Vault topology: one vault per connector.** A single workspace vault would cap us
at 20 connectors total (20 credentials/vault, `mcp_server_url` unique per vault)
and attach every credential to every session. Per-connector vaults dodge the cap
and scope credentials to assignment: session create passes exactly the vaults of
the connectors assigned to that agent.

### 4b. OAuth flow — the "no preset list" ladder

The add-connector flow probes the pasted URL and walks down:

1. **Unauthenticated probe** — MCP `initialize` against the URL. Success →
   `auth_kind: none`, done (no vault credential at all).
2. **401 → discovery** — RFC 9728 protected-resource metadata
   (`WWW-Authenticate` / `/.well-known/oauth-protected-resource`) → RFC 8414
   authorization-server metadata.
3. **Client registration** — RFC 7591 dynamic client registration when the AS
   supports it; otherwise the dialog asks for a manual `client_id`
   (+ optional secret) with a hint linking the server's docs.
4. **Authorization-code + PKCE** in a popup → `GET /api/connectors/oauth/callback`
   (state-validated, one active flow per connector) → token exchange.
5. **Store**: encrypt tokens into D1, create the vault + `mcp_oauth` credential —
   with the `refresh` block **only when a `refresh_token` was granted** (that is
   what "auto-refresh where possible" means concretely; access-token-only grants
   work until expiry, then the connector flips to `auth_error` and prompts
   re-auth). `token_endpoint_auth` per client type: `none` /
   `client_secret_basic` / `client_secret_post`.
6. **No-OAuth escape hatch** — a "use a bearer token instead" option stores a
   pasted token as a `static_bearer` credential. The dialog warns that hosted MCP
   servers usually want OAuth tokens, not the service's native API keys.

MCP client + OAuth plumbing: `@modelcontextprotocol/sdk` (already a dependency
for the server side) provides the Streamable HTTP client and auth helpers; the
discovery/registration steps are small enough to own if its client-auth API
doesn't fit the Worker environment.

### 4c. Agent wiring (`modules/anthropic`, `modules/router`)

- **Registration/sync:** `syncAgent` gains the connector list — `mcp_servers`
  becomes `[workspace MCP, ...assigned connectors]`, each connector also adding an
  `mcp_toolset` entry (`always_allow`, matching the existing policy rationale in
  `gateway.ts`).
- **The token landmine, resolved:** agent updates replace the whole `mcp_servers`
  array, and the workspace MCP URL embeds the per-agent plaintext token — which
  only exists at issuance (we store only the hash). A connector-assignment resync
  therefore cannot reconstruct the current workspace URL. **Fix: rotate the
  agent's MCP token on every connector assignment change** — the rotation
  machinery exists (`agents/mcp-token.ts`), rotation yields a fresh plaintext
  token to embed, and no security posture changes. Rotation is **deferred until
  the agent has no active session** (the agent row's `sessionId` is the gate),
  since invalidating the token mid-session would cut off a running session's
  workspace MCP access. Skills-only changes never rotate — see 5b. (Alternative —
  persisting the plaintext token encrypted — is more convenient but a deliberate
  posture change; not recommended.)
- **Session create:** router passes `vault_ids` = vaults of the agent's assigned
  connectors. `vault_ids` can't be changed on a running session, so an assignment
  change takes effect on the agent's *next* session — the UI says so.
- **Health:** `session.error` events mentioning MCP auth failures set the
  connector's `auth_error` status + `last_error`, surfaced in the UI.

### 4d. UI (every feature clickable, per the standing acceptance rules)

| Feature | Path through the UI |
|---|---|
| Connectors directory | sidebar → **Connectors** (new section, like Wiki) |
| Add connector | Connectors → "Add connector" → URL → OAuth popup / bearer fallback |
| Connector detail | Connectors → row → status, discovered tools, assigned agents, Test connection, Re-authorize, Disable, Remove |
| Assign to agent | agent rail → Edit (agent settings) → **Connectors** picker |
| Health at the agent | agent rail profile → connector chips with status dot |

Remove = archive vault credential + delete rows + resync affected agents.

### 4e. Testing

- Unit: OAuth ladder against a mocked AS (discovery, DCR, PKCE exchange, refresh,
  rotation-staleness path), encryption round-trip, `mcp_servers` array composition
  incl. token rotation on assignment change.
- Playwright: add-connector flow against a stub MCP server (one no-auth, one
  OAuth) running in miniflare; assignment picker; status states.
- **Visual acceptance (real APIs):** add a real OAuth'd remote MCP server (e.g.
  Linear's `mcp.linear.app`) through the popup flow; assign it to an agent; ask
  the agent in chat to use one of its tools; the result posts to the channel;
  connector detail shows `connected` and the tool list; revoke server-side →
  status flips to `auth_error` with a working Re-authorize button.

---

## Phase 5 — Skills (versioned, agent-authored, self-healing)

**Goal:** a top-level Skills directory in the sidebar; full skills (SKILL.md +
scripts/resources) with immutable versions; assignment from the agent settings
page; agents author and repair skills through MCP tools, and fixes propagate via
`"latest"`.

### 5a. Data model (`modules/skills`)

```
skills
  id, slug (unique), name, description,        -- mirrors SKILL.md frontmatter
  anthropic_skill_id,                          -- null until first publish succeeds
  latest_version, created_by (user | agent:<id>),
  sync_status (unsynced | synced | error), sync_error,
  created_at, updated_at

skill_versions                                  -- immutable once created
  id, skill_id, version (int, monotonic),
  anthropic_version,                            -- Anthropic's version identifier
  changelog (short "why", esp. for auto-heal fixes),
  created_by, created_at

skill_files
  id, skill_version_id, path (e.g. SKILL.md, scripts/run.ts),
  r2_key, size, content_type
```

Files live in R2 (same rule as attachments: never blobs in D1). A version is a
complete file set — new version = full copy-on-write of the file list, so old
versions stay exactly reproducible.

**Publish pipeline:** validate (SKILL.md exists, frontmatter parses, name/slug
match, per-file and total size caps) → write D1/R2 → push to Anthropic
(`POST /v1/skills` first time, `POST /v1/skills/{id}/versions` after) → record
`anthropic_version`. Anthropic sync failures keep the local version usable and
mark `sync_status: error` with retry from the UI — the mirror is one-directional,
local is the source of truth.

```
agent_skills
  agent_id, skill_id,
  pinned_version (int | null)                   -- null = track "latest"
```

Default is **track latest** — that's the auto-heal propagation mechanism (5d).
Pinning is the escape hatch for an agent that must not move.

### 5b. Agent wiring

- `syncAgent` gains `skills: [{type:"custom", skill_id: anthropic_skill_id,
  version: pinned ?? "latest"}]` for the agent's assignments (spike 2 confirms the
  update shape first). Skills not yet mirrored (`anthropic_skill_id` null after a
  failed publish) are skipped, so an unsynced skill can never produce a broken
  `skills` entry — it's usable in the UI but reaches agents only once the mirror
  retry succeeds.
- **Skills-only changes do *not* rotate the MCP token.** They go out as a partial
  `agents.update` carrying only `skills` (omitted fields preserved — exactly what
  spike 2 verifies), leaving `mcp_servers` and the embedded token untouched.
  Rotation is reserved for connector changes, which genuinely rebuild the
  `mcp_servers` array. This matters because `skill_create` auto-assigns the
  authoring agent *mid-session*: a rotation there would invalidate the token in
  the very MCP URL that session is talking through — the agent would sever its
  own connection by creating a skill.
- Agent settings UI enforces and displays the **20-skills-per-agent** cap.
- Standing workspace instructions (`modules/anthropic/system-prompt.ts`) gain a
  skills section: what skills are, that the agent can create and version them via
  the `skill_*` tools, and the self-heal contract (5d).

### 5c. MCP tools (`modules/mcp`) — agents develop skills

| Tool | Behavior |
|---|---|
| `skill_list` | All skills: slug, name, description, latest version, whether assigned to the caller |
| `skill_read` | Full content of a version (default latest): SKILL.md + file list + file contents on request |
| `skill_create` | New skill from `{slug, files[]}` → validate → version 1 → publish. Auto-assigns the authoring agent (tracking latest) |
| `skill_update` | New **version** of an existing skill from a full file set + required `changelog`. Never mutates an existing version |

Authoring workflow the instructions push: draft and test scripts on the agent's
own computer / session sandbox first, then `skill_create`/`skill_update` with the
proven files. Assignment to *other* agents stays a human action in the UI (an
agent auto-assigning skills to peers is a capability escalation we don't ship in
v1).

### 5d. Auto-healing

Deliberately simple in v1 — no router-driven repair loop:

1. **Detection is in-session:** the agent that trips over a broken skill sees the
   failure directly (script error output in its own sandbox).
2. **The standing instructions define the contract:** when a skill fails, do not
   work around it silently — diagnose, fix the files, `skill_update` with a
   changelog explaining the failure and fix, then retry the task with the new
   version.
3. **Propagation is `"latest"`:** every agent tracking latest gets the fix on its
   next session automatically. Pinned agents are exempt by choice.
4. **Audit trail:** versions + changelogs make every heal visible in the skill's
   history UI ("v3 — fixed: script assumed bash, sandbox runs sh", authored by
   agent X).

If in practice agents fail to self-heal reliably, the escalation path (later, not
now) is a router hook: skill-attributed `session.error` → wake the authoring
agent with the error context.

### 5e. UI

| Feature | Path through the UI |
|---|---|
| Skills directory | sidebar → **Skills** (top-level, like Wiki) |
| Skill detail | Skills → row → rendered SKILL.md, file tree (view/download), version history with changelogs + authors, assigned agents |
| Create skill (human) | Skills → "New skill" → slug/name/description + file upload (or start from a SKILL.md template) |
| New version (human) | skill detail → "Edit" → modify files → save = new version |
| Assign to agent | agent rail → Edit (agent settings) → **Skills** picker with pin-version option and 20-cap indicator |
| Agent-authored activity | skill history shows `agent:<name>` as version author; agent rail Activity tab logs `skill_create`/`skill_update` calls |

The agent edit surface grows from the current dialog into a settings page/panel
with sections (profile, skills, connectors) — the dialog is already crowded and
both pickers land in the same cycle-pair.

### 5f. Testing

- Unit: SKILL.md frontmatter validation, version immutability (update never
  touches existing rows/objects), publish-pipeline failure handling, MCP tool
  handlers (incl. auto-assign on create), `skills` array composition with pins.
- Playwright: create skill with a script file → appears in directory; new version
  → history shows both; assign in agent settings; pin a version.
- **Visual acceptance (real Anthropic API):**
  1. Create a skill with a script via the UI; assign it; ask the agent to use it;
     the agent applies the skill in-session.
  2. Ask an agent to *build* a skill for a described task → it appears in the
     Skills directory, authored by the agent, auto-assigned.
  3. **Self-heal:** hand-break the skill's script with a new version; ask an
     assigned agent to use the skill → it hits the failure, publishes a fixed
     version with a changelog, completes the task; a second agent tracking latest
     uses the fixed version without intervention.

---

## Risks

| Risk | Mitigation |
|---|---|
| Assignment resync would wipe the workspace MCP URL (plaintext token exists only at issuance) | Rotate the agent's MCP token on connector changes, deferred to session-idle; skills changes are token-preserving partial updates (4c, 5b) |
| Refresh-token rotation desyncs our management copy from the vault | Vault is session source of truth; management copy degrades independently to "re-authorize" without touching sessions (4a) |
| Arbitrary user-supplied MCP URLs (SSRF, malicious servers) | URL validation (https only, no private ranges); tools run on Anthropic's side, not in our Worker; connector tools are per-agent opt-in |
| Hard caps: 20 mcp_servers & 20 skills per agent, 20 credentials per vault | Per-connector vaults; caps enforced + displayed in the pickers |
| `vault_ids` is create-only | Assignment changes apply next session; stated in the UI |
| Skills/vault API shapes unverified in spots | The two phase-entry spikes run before any dependent code |
| Agent-authored skills are prompt-injectable content executed with real capability | Skills only run for agents they're assigned to; assignment to other agents is human-only; version history is fully auditable |
| Runaway heal loops (fix → still broken → fix …) | Session budget caps already bound cost; changelog history makes loops visible; pinning stops propagation of a flapping skill |

## Suggested build order

1. Rename `modules/connectors` → `modules/bridges` (mechanical, own commit).
2. Phase 4 connectors: spike vault CRUD → module + OAuth ladder → agent
   sync/rotation → UI → acceptance.
3. Phase 5 skills: spikes 1+2 → module + publish pipeline → MCP tools + standing
   instructions → UI (incl. the agent settings page both phases need — build it
   in Phase 4, extend in 5) → auto-heal acceptance.

Phase 4 first: it builds the agent-settings resync plumbing and the settings page
that skills assignment extends, and connectors have the bigger unknown (OAuth
against arbitrary servers) — better to hit that early.
