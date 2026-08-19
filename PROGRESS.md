# Progress Log

A reverse-chronological log of implementation cycles in this project — what was
done, what went wrong, and what to avoid next time. Newest entry first.

---

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
