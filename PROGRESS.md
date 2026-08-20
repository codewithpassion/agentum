# Progress Log

A reverse-chronological log of implementation cycles in this project — what was
done, what went wrong, and what to avoid next time. Newest entry first.

---

## Cycle 7 — Phase 5: Skills (versioned, agent-authored) (2026-08-20)

**Goal:** Implement Phase 5 of docs/plan-connectors-skills.md — workspace skills published to the Anthropic Skills API, versioned and pinnable per agent, authorable by agents themselves via MCP tools.

**What we did:**
- Ran both entry spikes green against the live API first (honoring the spike-first gate): multipart upload with the path encoded in the filename, version ids are epoch-microsecond strings, `"latest"` is stored literally so publishing a new version needs no agent resync, partial `agents.update` preserves omitted fields in both directions, and skill delete has no in-use protection — versions must be deleted before the skill
- Built modules/skills: migration 0011, skill files in R2, publish pipeline with local-first `sync_status` (R2 stays source of truth, Anthropic sync can lag or fail without losing data)
- Agent wiring: skills-gateway + `composeAgentSkills` do a skills-only partial `agents.update` with NO token rotation (asserted in tests); system prompt gained a skills section with the self-heal contract
- 4 MCP tools — `skill_list` / `skill_read` / `skill_create` / `skill_update` — with agent attribution; `skill_create` auto-assigns the new skill to the authoring agent
- UI: /skills directory + detail (rendered SKILL.md, file tree, version history, retry-sync, delete), create + new-version editors, agent-settings Skills tab with pin dropdown + 20-skill cap, rail chips on the agent profile
- 525 unit tests + 24/24 Playwright green; implemented via sequential forge agents (skills-spike, skills-backend, skills-ui) plus a Sonnet browser verifier (verify-phase5)
- Browser acceptance PASSED all 9 steps against the live Anthropic API: skill published for real → "synced", v1 immutability after publishing v2, pin/unpin, and delete cleaned up the Anthropic side
- SKIPPED (pre-authorized blockers): in-session acceptance — an agent using a skill, an agent authoring a skill, and the self-heal round-trip — requires a cloudflared tunnel + live sessions; same loopback limitation as Phase 4 (agent resync fails in dev with "localhost resolves to loopback", surfaced as a non-blocking outcome string while local state stays correct)

**Lessons learned:**
- The Skills API download endpoint is unusable with workspace keys + the `skills-2025-10-02` header — R2 must stay the source of truth for skill files
- The markdown renderer turns YAML frontmatter into a setext h2, so the UI strips frontmatter before rendering SKILL.md
- `MAX_AGENT_SKILLS` had to live in a pure module (validate.ts) to stay browser-importable
- e2e stub servers run under Node (`node:http`), not Bun — same constraint as Phase 4's stub MCP servers

**Avoid next time:**
- Don't resync agents on new skill versions — `"latest"` is stored literally at Anthropic, so publish alone is enough
- Don't delete a skill without deleting its versions first; there is no in-use protection on the Anthropic side
- Don't fetch skill files back from the Skills API — serve them from R2

## Cycle 6 — Phase 4: Connectors — remote MCP servers with OAuth (2026-08-20)

**Goal:** Implement Phase 4 of docs/plan-connectors-skills.md — user-added remote MCP connectors with a "no preset list" OAuth ladder, credentials held in Anthropic Vaults, and per-agent connector assignment.

**What we did:**
- Renamed modules/connectors (Slack bridge) to modules/bridges (4c82bc2), freeing the name; routes moved `/api/connectors` → `/api/bridges` — the Slack Events Request URL is now `/api/bridges/slack/events` and must be updated in the Slack app config
- Ran the Phase 4 entry spike against the live API (`bun scripts/anthropic-spike.ts vaults`): vault CRUD, `static_bearer` + `mcp_oauth` (with `refresh` block) credentials, secret updates, `mcp_server_url` immutability, archive/delete — honoring Cycle 5's spike-first gate
- Built modules/connectors (4a/4b): migrations 0009/0010 (`connectors`, `connector_oauth_flows`, `agent_connectors`, `agents.connector_resync_pending_at`), OAuth ladder RFC 9728 → 8414 → 7591 → 7636 PKCE + RFC 8707 `resource`, token encryption, health checks, usability cap with dropped-connector reporting
- Agent wiring (4c): `vaults.ts` VaultGateway keeps the SDK confined to modules/anthropic (same pattern as gateway.ts); `agent-connectors.ts` composes `mcp_servers` + deduped `vault_ids`; the router settles deferred connector resyncs at the only safe moment — just before session create, when the agent provably has no session
- UI (4d): /connectors list + detail routes, setup dialog with OAuth popup, agent-settings Connectors tab with picker, connector chips on the profile, sidebar Connectors section
- e2e (4e): connectors.e2e.ts drives the acceptance script against stub MCP servers stood up in-run (open, OAuth-secured with its own tiny auth server, bearer-only); 462 unit tests + 19 Playwright tests (6 new) all green
- Browser acceptance (verify-phase4, Sonnet agent) PASSED all 8 steps against the live app + real APIs — added the public Cloudflare Docs MCP server (`https://docs.mcp.cloudflare.com/mcp`, no-auth), verified detail/tools/Test connection, tabbed agent settings with picker + cap indicator, rail chips, assign/unassign persistence, disable/enable; 14 screenshots in docs/acceptance/phase4/. Real-OAuth acceptance against a third-party server (e.g. Linear) SKIPPED — pre-authorized blocker, no third-party credentials in this environment
- Session ran four sequential forge agents (rename, vault-spike, connectors-module + connectors-ui as one resumed pair, agent-wiring) plus verify-phase4; Phase 4 lands as one commit right after this entry

**Lessons learned:**
- Credential `mcp_server_url` is immutable at Anthropic — changing a connector's URL means a new credential, not an update (proven in the vault spike)
- `mcp_oauth` credentials only auto-refresh when a `refresh` block is granted; a grant without one simply works until expiry
- A session fixes both `mcp_servers` and `vault_ids` at create — connector assignment changes can only reach an agent's NEXT session, so resync is deferred and settled in the router right before startSession
- The router's sessionId gate can lag by one alarm (a retired session is nulled when the pump reaches it), so a resync landing in that window defers again — matching what the UI promises anyway
- Playwright specs execute in Node workers, so the e2e stub MCP server had to use `node:http`, not `Bun.serve`, in this otherwise Bun-first repo
- The vaults API needs `?beta=true` on every path in addition to the `managed-agents-2026-04-01` header (SDK 0.118 `client.beta.vaults.*` handles both); vault/credential delete is real deletion (unlike agents' permanent archive), and deleting a vault with live credentials succeeds — so "Remove connector" is a single `vaults.delete`
- `mcp_server_url` is unique per vault, not per workspace — this is what makes the one-vault-per-connector topology work
- The SDK's MCP transport swallows the 401's `WWW-Authenticate` header (the OAuth ladder's trigger), so the probe is hand-rolled Streamable HTTP
- In dev without a tunnel, every connector-assignment resync fails at Anthropic ("MCP server URL host localhost resolves to loopback") — visible only as the agent-profile error banner; the Connectors picker itself shows no failure signal (UX gap worth revisiting)

**Avoid next time:**
- After deploying the bridges rename, update the Slack app's Events Request URL to `/api/bridges/slack/events` — the old path is gone
- Don't expect connector changes to affect a live session — they attach at session create only
- Don't leave drizzle.config.ts pointing at a renamed schema path — it silently emits DROPs for the moved tables on the next `db:generate` (caught before damage this cycle)

## Cycle 5 — Workspace UI polish, categories, hierarchical wiki + connectors/skills plan (2026-08-20)

**Goal:** Post-Phase-3 polish pass — sidebar/workspace UX cleanup, channel membership management, a hierarchical wiki, and a plan for the next capabilities (Connectors & Skills).

**What we did:**
- Sidebar overhaul (3760c10): collapsible sections persisted in localStorage with search auto-expand; "Direct messages" renamed to "Agents"; Wiki moved to a top-bar icon; footer shows the signed-in user's name
- New categories module (migration 0008, `/api/categories`): user-created categories that channels and agents sort into via per-row menus
- Channel settings gained a Members section — view, add agents, remove members (new member DELETE route), header count kept in sync
- Hierarchical wiki (44cd2c4): slugs may contain `/` (per-segment `slugifyPath`), collapsible folder tree, folder-index view for folders without their own document, `/wiki/$slug` converted to splat route `/wiki/$` so slashed slugs deep-link, `[[Ops/Runbooks]]` links resolve to nested pages; nested-page e2e added
- Ran four forge agents this session (forge-backend, forge-members, forge-sidebar, forge-wiki) on disjoint scopes; both commits batch-landed at the end
- Drafted docs/plan-connectors-skills.md (uncommitted): Connectors as user-added remote MCP servers with OAuth via Anthropic Vaults (`vault_ids` at session create, auto-refresh), Skills via the versioned skills API (`skills-2025-10-02` beta), phase-entry API spikes, and a pending naming decision — rename the Slack module to `modules/bridges` so `modules/connectors` can mean MCP connectors

**Lessons learned:**
- Four forge agents shared one working tree without conflict: backend first (sole owner of the shared `lib/api.ts` contract), then sidebar + members in parallel, then wiki. What made it safe: every prompt pinned the exact API contract, named the files the agent must NOT touch, and scoped formatting to touched files only (no repo-wide `ultracite fix`). This revises Cycle 2's "don't run forge agents concurrently on apps/web" — concurrent is fine with explicit disjoint file ownership
- A forge agent died at startup on a transient Anthropic API server error; a one-line "continue from the top" resume message recovered the full task with no rework
- Renaming a TanStack route file (`wiki.$slug.tsx` → `wiki.$.tsx`) leaves `routeTree.gen.ts` stale, so typecheck fails confusingly — run `bun run generate-routes` before diagnosing anything else
- `%2F`-encoded slashes round-trip through Hono `:slug` params intact (proven end-to-end over workerd), so path slugs needed no regex route params
- The e2e smoke test flaked once (new agent's sidebar button missing), order/state-dependent with the persistent local D1; it passed in isolation and in both later full runs
- Anthropic Vaults make an OAuth refresh daemon unnecessary for MCP connectors: credentials attach at session create and Anthropic refreshes `mcp_oauth` tokens itself; but `vault_ids` is session-create-only and invalid credentials surface as `session.error`, not a create failure
- The module named `connectors` (Slack bridge) is not the product feature "Connectors" — naming collision flagged in the plan before any new code

**Avoid next time:**
- Don't start Connectors/Skills implementation before the two phase-entry spikes (skill version upload shape; `agents.update` accepting `skills`) — the plan gates on them
- Don't locate wiki tree links by visible name in e2e — the local D1 persists across runs, so leaf titles collide; key assertions on `href` instead

## Cycle 4 — Phase 3: agent computer, agent browser, right-rail agent screen (2026-08-20)

**Goal:** Implement Phase 3 of docs/plan.md (final phase) — give each agent a computer and a browser, and surface both in a right-rail agent screen.

**What we did:**
- Built modules/computer wrapping `@cloudflare/computer` 0.2.1 (preview): an AgentComputer DO per agent via `withWorkspace`, WorkerShellBackend exec working locally, 5 MCP tools, path/SSRF-style validation
- Added a shared modules/activity log (D1 `agent_activity` table + API) used by both computer and browser
- Built modules/browser on the Browser Run Workers binding + `@cloudflare/playwright` — real binding verified, 5 MCP tools, screenshots to R2, SSRF guard; Chromium (not Kitesurf) with session reuse via undocumented `persistent:true`
- Built the right-rail agent screen: Screen/Files/Activity/Profile tabs, polling 4s working / 15s idle, upload into the agent computer, GrokBot-style empty states
- 266 unit tests + 12 e2e passing; Phase 3 browser acceptance passed all steps with real Anthropic + Browser Run, including an agent-to-agent delegation -> browse -> file -> wiki chain (screenshots in docs/acceptance/phase3/)

**Lessons learned:**
- WorkerShellBackend requires `WorkspaceServiceProxy` as a named export of the Worker entry module — it's looked up via `ctx.exports`, and this is undocumented
- Kitesurf through the Browser Run binding never acquires a session (`sessionId()` undefined in @cloudflare/playwright 1.3.5), so multi-call flows need Chromium; session reuse requires `persistent:true` on both launch AND connect, absent from the published types
- The browser binding in local dev needs `remote:true` + `wrangler login` + `CLOUDFLARE_ACCOUNT_ID`; miniflare's local Chrome fails to start on this box
- D1's `unixepoch()*1000` column default is whole-second precision — set `createdAt` from JS or same-run rows order randomly
- The sync-status UI only flips to "registered with Anthropic" on the next data refresh (registration is waitUntil-async) — minor UX gap, a freshly created agent gives no ready signal
- Known gaps deferred: Files-tab download link serves a JSON envelope, not raw bytes (needs a bytes route in 3a); Slack live round-trip still blocked on tokens; Worker Loader availability in the deployed CF env unverified

**Avoid next time:**
- Don't use Kitesurf through the Browser Run binding for anything needing more than one call — it's sessionless there
- Don't rely on D1 timestamp column defaults for ordering rows created in the same second
- Don't expect miniflare's local Chrome to work on this machine — go straight to `remote:true`

## Cycle 3 — Phase 2: Anthropic Managed Agents, agent router, MCP, wiki, Slack (2026-08-20)

**Goal:** Implement Phase 2 of docs/plan.md — wire real Anthropic Managed Agents into the workspace (routing, MCP tool access), plus the wiki module and Slack connector.

**What we did:**
- Built modules/anthropic as the gateway to the Managed Agents API — validated first with a live spike, then confirmed a real session round-trip through the workspace
- Added the AgentRouter Durable Object with hybrid wake: immediate on mention/DM, 5-minute digest otherwise, a 5-session concurrency queue, and loop guards against agent-to-agent ping-pong
- Exposed an MCP server at `/mcp/:agentToken` (@hono/mcp + @modelcontextprotocol/sdk) with 9 tools; agent tokens are stored hashed, with a rotate action in the UI
- Built the wiki module: pages, revisions, R2 assets, heading anchors, `[[wiki-links]]`, with full UI
- Built the Slack connector: signature verification, idempotent inbound events, mirrored outbound messages, and channel-bridging UI — live Slack round-trip SKIPPED (no workspace tokens; pre-authorized blocker)
- Fixed cite-tag stripping in the markdown renderer
- 190 unit tests + 9 e2e tests passing; browser acceptance passed all steps including observing the digest wake fire at exactly 5:00 (screenshots in docs/acceptance/phase2/)

**Lessons learned:**
- Anthropic environment names are NOT unique despite docs saying create returns 409 — the gateway must be list-first-adopt, or duplicate environments silently eat the 5-environment quota
- `mcp_toolset` defaults to `permission_policy: always_ask` — set `always_allow` explicitly or sessions park in `requires_action` and never call tools
- `events.list` has no after-id cursor, only `created_at[gte]` — cursor has to be timestamp plus client-side id slicing to avoid re-processing
- `agents.create` rejects loopback MCP URLs, so local dev needs a cloudflared quick tunnel; on this machine plain `cloudflared` picks up the resident /etc/cloudflared/config.yml (catch-all 404) — pass `--config <empty file>`; Vite 8 also blocks tunnel Host headers, fixed with `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.trycloudflare.com`
- The e2e Anthropic kill switch must go through `vite --mode e2e` — `.env.local` outranks process env, so exporting the variable is not enough
- `PUBLIC_APP_URL` in .env.local must be a public URL at agent create/edit time or registration with the Anthropic gateway fails

**Avoid next time:**
- Don't archive Anthropic agents/stores as "cleanup" — archiving is permanent
- Don't let two forge agents edit messaging/service.ts concurrently

## Cycle 2 — Plan Agentum + build Phase 1 workspace core (2026-08-20)

**Goal:** Turn the bootstrapped app into Agentum — plan the GrokBot-inspired agent workspace, then implement Phase 1 (channels, messages, agents CRUD) end to end with forge agents.

**What we did:**
- Committed the docs folder (ce3cce7) with docs/plan.md (docs/idea.md predates this session): Slack-like workspace on Claude Managed Agents + `@cloudflare/computer` + Kitesurf; confirmed decisions — hybrid agent wakeup, Cloudflare-native backend (DO/D1/R2), ephemeral sessions + memory stores, connector layer from day one (Slack in Phase 2)
- Wrote docs/design.md and ran Phase 1 as sequential forge agents: data layer -> UI -> e2e
- Data layer (uncommitted): Drizzle + D1 schema/migration (apps/web/drizzle/0000_init.sql), modules for messaging/agents/connectors with Hono routes, services, unit tests (mentions, attachment rules, errors); R2 `ATTACHMENTS` bucket + channel-room Durable Object wired in wrangler.jsonc
- UI (uncommitted): apps/web/src/components/workspace/ — sidebar, composer, message stream, thread panel, agent rail, agent/channel dialogs; new site chrome; six hand-rolled UI primitives instead of shadcn/ui
- E2E (uncommitted): Playwright suite (apps/web/e2e/) with auth.setup.ts reusing the dev-login flow to mint a storage state (.auth/user.json), plus smoke.e2e.ts covering agent -> channel -> mention+image -> thread -> live second browser -> agent rail
- Browser-driven Phase 1 acceptance completed and passed all 5 steps (agent create; channel+mention+image; thread + live second-session update; agent rail; layout vs grokbot.png), screenshots in docs/acceptance/phase1/; Phase 1 work is pending commit right after this entry

**Lessons learned:**
- Playwright auth: reusing `GET /api/dev-login` in auth.setup.ts gives a real Clerk session as storage state — no Clerk UI automation needed
- /dev-login had a real bug only visible in fresh browser profiles: clerk-js swaps `client.signIn` after `signIn.ticket()` succeeds, so the signal-based `finalize()` threw "Cannot finalize sign-in without a created session". Fixed by using the legacy ticket flow (`signIn.create({ strategy: "ticket" })` + `setActive(createdSessionId)`). The already-signed-in early-return path masked it in manual testing
- Clerk's provider remounts the React tree when the session resolves (children keyed on session id), wiping pre-resolve UI state — e2e tests must wait for a post-remount signal (we wait on `GET /api/channels`) before clicking
- shadcn/ui was skipped deliberately: its CLI rewrites styles.css tokens and would collide with the existing theme toggle; six primitives were hand-rolled instead (documented in docs/design.md)
- forge subagents' default model was unavailable (claude-opus[1m] API error) — forge tasks need an explicit model override

**Avoid next time:**
- Don't run two forge agents mutating apps/web concurrently — sequential data -> UI -> e2e worked cleanly
- Port 3000 is held by an unrelated app on this machine; pin dev/e2e servers to explicit ports with `--strictPort`

## Cycle 1 — Bootstrap app with Clerk auth + dev login (2026-08-19)

**Goal:** Bootstrap the app (Workers + Hono + TanStack Start + Clerk) through to a working custom /login page with one-click dev login.

**What we did:**
- Set up Cloudflare Workers + Hono + TanStack Start + Clerk (7ecc06f)
- Converted to Turborepo, moved the front end into apps/web (e6536d7)
- Added `GET /api/dev-login`: mints a Clerk sign-in token for a dedicated dev user and redeems it at `/dev-login` via `signIn.ticket` -> `signIn.finalize`, establishing a real session without a password touching the browser (f79532b)
- Gated dev login behind `DEV_LOGIN_EMAIL`/`DEV_LOGIN_PASSWORD` in `apps/web/.env.local`; their absence is the safety switch that keeps the route disabled in deployed environments
- Added `apps/web/scripts/create-dev-user.ts` (`bun run create-dev-user`) to create/refresh the dev Clerk user
- Moved Clerk sign-in off Clerk's hosted Account Portal onto a custom `/login` route (renamed from `/demo/clerk`), replacing the header's default `SignInButton` with a link to it, and removed the now-dangling "Demos > Clerk" nav entry (a2f0ade)
- Documented the dev login flow in AGENTS.md, CLAUDE.md, and .claude/CLAUDE.md so agents know to use it instead of Clerk's UI

**Lessons learned:**
- Clerk's default `SignInButton` redirects to the hosted Account Portal, which breaks a "single custom login page with a dev login option" UX — needed an explicit `/login` route + link instead of the default component

**Avoid next time:**
- Don't set `DEV_LOGIN_EMAIL`/`DEV_LOGIN_PASSWORD` outside `apps/web/.env.local` — their presence is what enables the dev-login route, so leaking them to a deployed environment would expose it
