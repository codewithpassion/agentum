# Analysis: the-brain

Repo: `/home/roboto/devel/the-brain`. Read-only analysis, 16 Oct 2026. Claims below were checked against code unless marked "docs only".

## 1. Purpose

The Brain is a multi-tenant persistent memory service on Cloudflare. It stores documents, facts, path-keyed agent memory, an entity graph, sessions and a wiki, and exposes them through an MCP server (with OAuth), a REST/tRPC API, a `brain` CLI, a TanStack dashboard and an Obsidian sync. It is deployed and connected to claude.ai as an MCP connector today.

For Harbourmaster it is a working example of four things: an OAuth-protected MCP server on Workers, one op registry that generates MCP, tRPC and CLI, session capture from Claude Code hooks, and a file-shaped knowledge lane (WebDAV over R2 plus OKF markdown bundles). My verdict on "service or copy" is in section 5, last paragraph.

## 2. Stack and deployment

| Area | What it uses |
|---|---|
| Language, runtime | TypeScript on Bun workspaces and Turborepo. Biome strict, tsc strict. `packages/*` test with `bun test`, `apps/api` with vitest on `@cloudflare/vitest-pool-workers` (real workerd D1). |
| API Worker | `apps/api`, one Worker `brain-api`: Hono REST, tRPC (`@hono/trpc-server`), `BrainMCP` Durable Object, 5 Workflows, 4 queues plus DLQs, cron (`*/5` and `0 3 * * *`). Compat date 2026-06-01, `nodejs_compat`. |
| Dashboard | `apps/dashboard`, separate Worker `brain-dashboard`, TanStack Start plus shadcn, service binding `BRAIN_API` to the API Worker. |
| Data | One shared D1 (Drizzle, 15 migrations `0000` to `0014`, FTS5 tables). Two Vectorize indexes (bge-m3, 1024d). R2 `the-brain-bodies`. KV `OAUTH_KV`. |
| AI | Workers AI through AI Gateway behind `embed()/gen()/rerank()` chokepoints. Models in `packages/shared/src/constants.ts`: bge-m3, llama-3.3-70b, bge-reranker-base, deepseek-v4-flash (KG extraction), whisper-large-v3-turbo. `AI_PROVIDER=openai-compatible` seam exists. |
| Auth | Clerk is the upstream IdP. `@cloudflare/workers-oauth-provider` ^0.8.1 is the OAuth 2.1 server for MCP. Machine tokens: `bdev_` (HMAC) and `bk_` (hashed API key). Vault WebDAV uses its own Basic credentials. |
| MCP libs | `agents` 0.7.0 (`McpAgent`), `@modelcontextprotocol/sdk` 1.26.0, `zod` ^3.25.76. |
| Hosting | Cloudflare account `a12823016aa16d0a8dd2678b258bd751`. API at `brain-api.dominik-fretz.workers.dev`, dashboard at `brain-dashboard.dominik-fretz.workers.dev` (from `wrangler.jsonc` vars). |

## 3. Module map

| Path | Responsibility | Notes |
|---|---|---|
| `packages/shared/src` | `Principal` (`principal.ts`), `defineOp`/`OpRegistry` (`ops.ts`), enums, constants, slug and heading-anchor helpers | Pure Zod 3 contracts. The root of the "one registry" idea. |
| `packages/db/src/schema` | Drizzle tables: `tenancy.ts` (orgs, memberships, api_keys, cli_auth_sessions), `governance.ts` (memory_audit, recall traces, trust), `sessions.ts`, `docgraph.ts` (pages, doc_links, page_revisions), `kg.ts`, `vault.ts`, `notion.ts`, `ops.ts` | About 32 tables. Far larger than Harbourmaster needs. |
| `packages/db/src/scoped` | `ScopedDB` (1369 lines), `ScopedVectorize`, `ScopedR2`, `predicates.ts` (scope and visibility), `audit.ts` (`batchWithAudit`) | The tenant isolation chokepoints. Only this package may name raw bindings. |
| `packages/db/src/auth` | `resolve.ts` (`resolvePrincipal`), `tokens.ts` (`bdev_`), `mint.ts` (`bk_`), `device.ts` (RFC 8628), `oauth-state.ts`, `clerk.ts` (JWKS verifier) | Credential chain: Clerk JWT, then `bdev_`, then `bk_`. |
| `packages/db/src/wiki` | `store.ts` (`WikiStore`), `ops.ts` (`wiki_*` ops), `okf-bundle.ts`, `entity-pages.ts`, `index-pages.ts`, `media.ts` | Wiki pages are `pages` rows with `ingested_via='wiki'`. D1 rows, not files. |
| `packages/db/src/memory` | `MemoryStore`, `okf.ts` (OKF v0.1 parse/serialize), `memory_set/get/list/history/rollback/forget`, `okf_import/export` | Path-keyed versioned agent memory. |
| `packages/db/src/sessions` | `store.ts`, `ops.ts` (`capture_turn`, `finalize_session`, `get_session_context`, `list_sessions`), `promote.ts`, `snapshot.ts`, `idle.ts` | Turns inline or offloaded to R2 `${tenantId}/sessions/${id}.jsonl`. |
| `packages/db/src/governance` | `ops.ts` (`audit_export`, `memory_review`, `break_glass_read`), `store.ts`, `audit-sink.ts` | Audit, trust grades, human promotion gate. |
| `packages/db/src/dream` | Nightly consolidation: dedup, digest, hygiene, contradiction, entity pages, indexes, reflect | The "learn from the log" engine. |
| `packages/db/src/search`, `graph`, `ai`, `backfill`, `notion`, `vault`, `admin` | Hybrid search and `think`, KG ops, AI wrappers, re-embed, Notion connection store and crypto, vault credentials, admin ops | |
| `packages/ingest/src` | Chunking, fingerprint, markdown normalise, importers (`sources/chatgpt.ts`, `claude-code.ts`, `notion.ts`, `obsidian.ts`) | Platform-neutral. |
| `packages/surface/src` | `catalog.ts` (1639 lines, op invokers), `mcp.ts`, `trpc.ts`, `cli.ts`, `registry.ts` (`buildRegistry`), `json-schema.ts` | Generates all three surfaces from the registry. `drift.test.ts` guards it. |
| `apps/api/src/index.ts` | Hono app, `createOAuthWorker`, `scheduled`, `queue`, exports of DO and Workflow classes | Wraps Hono in `OAuthProvider`. |
| `apps/api/src/mcp` | `agent.ts` (`BrainMCP`), `routes.ts` (`mountMcp`), `oauth-handler.ts` (`mcpApiHandler`), `server.ts` (`buildMcpServer`), `dispatch.ts`, `guide.ts` | Details in section 4. |
| `apps/api/src/oauth/authorize.ts` | `GET /authorize`, `POST /authorize/orgs`, `POST /callback` | Clerk sign-in HTML page, org picker, `completeAuthorization`. |
| `apps/api/src/device-flow` | CLI device-code login routes | |
| `apps/api/src/vault-dav` | WebDAV facade at `/dav` over R2 | Section 4. |
| `apps/api/src/vault-events`, `notion`, `notion-events`, `backfill`, `dream`, `sessions` | Queue consumers, Notion OAuth and poll sweep, Workflows, crons | |
| `apps/cli/src` | `brain` Commander CLI. `commands/generated.ts` from the registry, hand-written `hooks.ts`, `wiki.ts`, `auth.ts`, `dream.ts` | `brain hooks install` merges SessionStart and Stop hooks into `.claude/settings.local.json`. |
| `apps/dashboard/src` | Routes: wiki tree and editor (TipTap), memory, sessions, audit, graph, dreams, notion, vault-sync, api-keys, members | 65 `createServerFn` uses in `server/fns.ts`. |
| `apps/obsidian-plugin` | Ask, search, backlinks, capture to `memory_set`, pull via `okf_export` | Built `main.js` committed. |
| `scripts/boundary-lint.ts` | Regex scan that bans raw `D1Database`/`Vectorize`/`R2Bucket` names outside `packages/db`, plus a red-proof test | Cheap guard worth copying as an idea. |
| `docs/`, `PRD.md`, `sources/`, `reviews/`, `workflows/` | Plans, a 480 KB PRD, 8 review rounds, and the multi-agent scripts that wrote the PRD | The PRD tooling is Python, not reusable. |

## 4. Reusable pieces

Effort is rough days for someone who knows Workers. "Copy" means lift the code with edits. "Borrow" means rebuild from the pattern.

| What | Exact paths | Copy or borrow | Effort and fit | Brief section |
|---|---|---|---|---|
| OAuth-protected MCP server on Workers | `apps/api/src/index.ts` (`createOAuthWorker`, `resolveExternalToken`), `apps/api/src/mcp/{agent,routes,oauth-handler,server}.ts`, `apps/api/src/oauth/authorize.ts`, `packages/db/src/auth/oauth-state.ts` | Copy | 2 to 3 days. Fits fully. Gives dynamic client registration, PKCE S256 only, `/.well-known` discovery, and a Clerk sign-in page. A non-OAuth bearer (Clerk JWT, `bk_`, `bdev_`) still works through `resolveExternalToken`. The HTML in `authorize.ts` is inline and plain, restyle it. | Talking to agents, Auth |
| One DO per MCP session | `apps/api/src/mcp/agent.ts` (`BrainMCP`), `routes.ts` | Copy | Small. The reason is recorded in `IMPLEMENTATION_PLAN.md`: a DO shared per tenant lets session B's `onStart` overwrite session A's `this.props`, so A runs as B. Keep per-session keying. | Talking to agents |
| Single op registry generating MCP, tRPC and CLI | `packages/shared/src/ops.ts` (`defineOp`, `OpRegistry`), `packages/surface/src/{registry,mcp,trpc,cli,json-schema}.ts`, `apps/api/src/mcp/dispatch.ts`, `packages/surface/test/drift.test.ts` | Borrow the pattern | The Brain pins Zod 3 and uses the low-level MCP `Server` to avoid Zod-shape coupling. Harbourmaster's `packages/services` uses `zod ^4.6.5`, so a direct copy needs a port. `json-schema.ts` is hand-rolled for a closed Zod subset and would break on v4. | Talking to agents, Connectors |
| Two-gate capability filter on tools | `apps/api/src/mcp/dispatch.ts` (`mcpToolsFor`, `callMcpTool`), `packages/shared/src/principal.ts` (`scopeSatisfied`) | Copy | Small. `tools/list` hides write/admin tools from read-only principals, and `tools/call` re-checks, so a guessed tool name fails. Matches "minimal permissions, keep room to grow". | Auth |
| MCP guide and ops resources, teaching errors | `apps/api/src/mcp/guide.ts`, `server.ts` (`brain://guide`, `brain://ops`), `dispatch.ts` (`zodIssueSummary`) | Copy | Small. `instructions` injected on `initialize` plus Zod errors that name the bad field helped agents self-correct. | Talking to agents |
| Principal resolution at the edge | `packages/db/src/auth/{resolve,tokens,mint,principal}.ts`, `packages/shared/src/principal.ts` | Borrow, trimmed | Medium. The chain Clerk JWT, `bdev_` HMAC, `bk_` hashed key is sound. Drop teams, `allowedScopes`, visibility. Keep "401 when the active tenant is not named, never a silent default". | Auth |
| Machine token and API key minting | `packages/db/src/auth/tokens.ts` (stateless HMAC `bdev_`), `mint.ts` (`bk_`, SHA-256, `allowed_scopes = intersect(request, minter)`), `schema/tenancy.ts` (`api_keys`) | Copy | Small to medium. This is the closest thing to "agent credentials" in the repo. | Connectors and credentials, Slack triggers (bearer endpoint) |
| CLI device-flow login | `packages/db/src/auth/device.ts`, `apps/api/src/device-flow/routes.ts`, `apps/cli/src/auth/device.ts`, `schema/tenancy.ts` (`cli_auth_sessions`) | Copy | Medium. Useful if Harbourmaster ships a local CLI or a connector process that must authenticate as Dom. | Creating and running agents (local machines) |
| Reversible secret storage for outbound OAuth | `packages/db/src/notion/crypto.ts` (AES-GCM, key from a Worker secret), `schema/notion.ts` (`token_ciphertext`, soft revoke) | Copy | Small, about 60 lines, Web Crypto only. Lesson: vault credentials that clients send to us are hash-only (`vault_credentials.secret_hash`), while tokens we must send to someone else are encrypted and decryptable. Harbourmaster needs the second kind for every external connector. Single-key, no rotation. | Connectors and credentials |
| "Connect, confirm, persist" OAuth client flow | `apps/api/src/notion/routes.ts` (public `/notion/callback`), `packages/db/src/notion/{connect,oauth,store}.ts`, ops `connect_notion`, `confirm_notion_connection`, `disconnect_notion` | Borrow the pattern | Medium. The callback stashes the encrypted grant and redirects to a same-principal confirm step. That blocks login CSRF where the provider has no PKCE. It handles one provider with one auth type and has no refresh-on-expiry or re-auth trigger. | Connectors and credentials |
| Tenant isolation chokepoints | `packages/db/src/scoped/*`, `scripts/boundary-lint.ts`, `apps/api/test/isolation.canary.test.ts` | Borrow the idea only | Large and heavy. Harbourmaster is one org for now. Keep tenant_id on every row and the lint-style guard, skip scope/visibility/break-glass until needed. | Auth (later) |
| Mutation plus audit in one batch | `packages/db/src/scoped/audit.ts` (`batchWithAudit`), `schema/governance.ts` (`memory_audit`), `governance/ops.ts` (`auditExport`) | Copy | Small. Audit row commits in the same D1 `batch` as the change. `auditExport` writes new rows to R2 ndjson every 5 min with a cursor. | Logging |
| Session capture from Claude Code hooks | `apps/cli/src/commands/hooks.ts` (`mergeClaudeSettings`, `parseHookEnvelope`), `packages/db/src/sessions/{ops,store,promote,snapshot}.ts`, `apps/api/src/sessions/*` | Copy the hook merge, borrow the rest | Small for the hook kit (pure, tested, non-destructive). Medium for the store. Idempotent upsert on `(tenant, client, source_session_id)`, long turns offloaded to R2 jsonl. | Talking to agents (stored sessions) |
| Session context snapshot | `packages/db/src/sessions/snapshot.ts`, `dream/digest.ts`, ops `get_context_snapshot`, `get_session_context` | Borrow | Medium. A curated ~4 KB markdown, refreshed nightly and on a 5 min staleness check, injected at SessionStart. | Logging and knowledge |
| File-shaped wiki: WebDAV over R2 | `apps/api/src/vault-dav/index.ts` (PROPFIND, GET, PUT, DELETE, MKCOL, multipart streaming, `sanitizeRelpath`), `packages/db/src/vault/*`, `schema/vault.ts`, `scoped/r2.ts` | Copy | Medium. Real files in R2 under `${tenantId}/vault/`, Basic auth with revocable per-credential secrets. Closest match to "wiki as a file structure". Gives Obsidian and any WebDAV client a mount for free. | Logging and knowledge, Files |
| File-landed trigger | `apps/api/src/vault-events/consume.ts`, queue `brain-vault-events`, `VAULT_EVENTS_QUEUE.send` in `vault-dav` | Borrow | Small. PUT and DELETE enqueue an event, a consumer ingests it. Swap the consumer for "wake agent X". | Files, Slack triggers |
| OKF markdown bundles | `packages/db/src/memory/okf.ts` (`serializeConcept`, `parseDocument`), `wiki/okf-bundle.ts`, ops `okf_export/import`, `wiki_export_bundle/import_bundle`, `apps/cli/src/commands/wiki.ts` | Copy | Small. Plain markdown plus YAML frontmatter (`type` required), `index.md`, `log.md`. A portable format for a file wiki. | Logging and knowledge |
| Wiki as D1 rows with revisions | `packages/db/src/wiki/store.ts`, `pages/store.ts`, `schema/docgraph.ts` (`pages`, `page_revisions`, `doc_links`), `apps/dashboard/src/routes/wiki.$.tsx` | Borrow | Large. DB-shaped alternative to the vault. Gives backlinks, versions, rollback, search. Not file commands. | Logging and knowledge |
| Upload to markdown | `apps/api/src/index.ts` upload route (`AI_MARKDOWN_TYPES`, `env.AI.toMarkdown`), `packages/db/src/ai/transcribe.ts` | Borrow | Small. PDF, docx, html, images to markdown, audio through Whisper. | Files |
| Boundary lint | `scripts/boundary-lint.ts`, `scripts/boundary-lint.test.ts` | Copy | Tiny. Regex scan with a test that proves it fails on a bad file. Adapt the banned names to Harbourmaster's layer rules ("no `@repo/db` imports in the app"). | Quality gate |

Not reusable in Harbourmaster as written: `apps/dashboard` (it uses `createServerFn` 65 times, which Harbourmaster's CLAUDE.md forbids; use tRPC through `getTrpc()`), the Python PRD pipeline, `workflows/*.workflow.js`, and the Obsidian plugin (single purpose).

## 5. Brief coverage

**Creating and running agents.** Nothing. The Brain stores memory for agents, it does not create, host or run them. No runtime selection, no machine or container handling, no agent definitions. The device-flow login and `bdev_` tokens are the only pieces that help a remote process identify itself.

**Talking to agents.** Partly. The MCP server lets Claude read and write memory, and sessions are stored (`capture_turn`, `list_sessions`, `get_session_context`, `recall`, `think`), so an agent can look back at its own history. There is no way to message an agent, no inbox or forum, and no "ask agent B for an extract of session X" call. Sessions are readable per user, filtered by `visibility` (`private`, `team`, `world`); an agent-to-agent read would need a new op. The MCP OAuth and the per-session DO are the reusable parts for "Hey Claude, message Bruce".

**MCP connectors and credentials.** Partly, and only the inbound side. The Brain is an MCP server. It does not manage outbound MCP connectors, so there is no central connector list, no assignment to agents, no header-auth type, no multiple OAuth setups. Mapping to the three credential cases:

- Linked to a user, acting as them: only the Notion lane (`connect_notion`, `/notion/callback`, `confirm_notion_connection`, AES-GCM in `notion/crypto.ts`, one connection per Notion workspace, `workspace_id` maps to the tenant). One provider, no refresh or re-auth trigger.
- A colleague tasks the agent, so it uses the colleague's credentials: nothing. Credentials belong to the tenant connection, not to the requesting user.
- Agent's own credentials for routines and events: `bk_` API keys (`api_keys`, `resolveApiKeyPrincipal`) and `bdev_` HMAC tokens, scoped by capability and revocable.
- Secret vault handed to agents: nothing. The only encrypted store is the Notion token column.

**Slack, triggers and gateways.** Nothing for Slack. Triggers are partial: cron sweeps (`*/5`, nightly 03:00), queue consumers, and a public webhook with signature check (`/notion/webhook`, `packages/db/src/notion/webhook.ts`). There is no bearer-authed "run this" endpoint for agents, though `bk_` keys on the REST API come close.

**Files.** Partly. Upload with conversion to markdown, a WebDAV facade over R2 with per-tenant credentials, R2 multipart streaming for large attachments, and "file landed" events through a queue. Notion and Obsidian are the only sync sources. Nothing for Google Drive, Meet folders, OneDrive or Samba.

**Logging and knowledge.** Partly, and it is the strongest match.

- Log: `memory_audit` is a per-mutation audit row written in the same `db.batch` as the change (`batchWithAudit`), `memory_recall_traces` records each kept search hit off the read path, and `auditExport` copies new audit rows to R2 ndjson. This is not an every-action event log. Reads, tool calls and agent decisions are not recorded except as recall traces. Append-only holds by convention: no UPDATE or DELETE code path touches the tables, and no trigger enforces it (grep of the migrations found triggers only for FTS).
- Learning from the log: the Dream engine (`packages/db/src/dream/`) runs nightly over facts, sessions and recall traces to dedupe entities, resolve contradictions, write a digest and update entity pages. It is real, but it is built around the Brain's own tables.
- Wiki: three shapes exist and they are not interchangeable. `WikiStore` keeps pages as D1 rows with revisions, backlinks and search. OKF bundles are the markdown file format for export and import. The WebDAV vault is real files in R2. For "a file structure with file commands" the right base is the vault lane plus the OKF format, not `WikiStore`. Nothing here runs shell commands over the files (no `just-bash`, grep found none).

**Auth and permissions.** Mostly solved. Clerk sign-in, OAuth 2.1 for MCP clients, machine tokens, API keys, roles (`owner|admin|member|readonly`), a capability axis (`read|write|admin`) kept apart from the data-scope axis. It goes well past "minimal permissions". Harbourmaster should take the Principal shape and the two-gate tool filter and leave out visibility tiers, teams and break-glass for now.

**Service or copy?** My recommendation is both, split by layer. Run the Brain as a service for memory and knowledge, since it is deployed, authed by Clerk and already reachable over MCP and REST with a `bk_` key. Harbourmaster agents can call `think`, `recall`, `memory_*` and `capture_turn` without owning that code. Copy the serving and credential patterns into Harbourmaster itself: `createOAuthWorker` with `BrainMCP` per-session, the `resolveExternalToken` bridge, the `/authorize` Clerk page, `bk_` and `bdev_` tokens, AES-GCM secret storage and the Claude Code hook merge. Do not copy the 32-table schema or the `Scoped*` stack. Two caveats on the service route. The Brain has no agent concept, so the append-only action log Harbourmaster wants should be its own table. And the shared wiki as files should use the vault and OKF ideas, because `WikiStore` rows cannot be driven with bash-style commands. If Dom wants one shared knowledge base, put the Brain's vault in front and let Harbourmaster mount it by WebDAV.

## 6. Gotchas and lessons

Recorded in docs or commits, then checked where I could:

- Every test stubs Workers AI and Vectorize. An empty knowledge graph reached production (commits `88ea341`, `d00d29a`, `bd81877`, `docs/v2-implementation-plan.md:45`). The real-AI gate is still three `test.todo`s (`docs/gap-analysis-2026-08-18.md` G3).
- D1 caps LIKE patterns at 50 bytes. Fixed by LIKE-free prefix queries (commit `2026-07-16`).
- D1 allows 100 bound parameters per statement, so writes batch 10 rows at a time (`CHUNK_DB_BATCH_SIZE`). No interactive transactions, only `db.batch`.
- FTS5 external-content tables have no tenant column. `MATCH ... AND tenant_id=?` leaks. Every hit must be joined back to the scoped base table (IMPLEMENTATION_PLAN invariant 4). A new search arm can forget this easily.
- Vector namespace is not the isolation boundary. The mandatory D1 re-check after each vector hit is.
- MCP DO keyed per tenant lets one session overwrite another's `props`. The PRD said per (tenant, slug), the build uses per session and the plan ratifies the change.
- The W6 collab design warns that the "per-call D1 re-check" argument does not carry over to a shared DO room. Every joiner needs their own visibility gate (`docs/v3-w6-collab-design.md:44`).
- Bare `wrangler deploy` ships a stale `dist/` for the dashboard. Use `bun run deploy` (`gap-analysis-2026-08-18.md`).
- Wiki sidebar and namespace landing truncate at a 500-row listing cap. Media has no list, GC or page-level ACL.
- Wikilinks inside headings produced dead anchors until the anchor logic was shared between server and dashboard (`docs/wiki-heading-anchors-discoverability-plan.md`).
- Agent-written wiki content must not feed back into extraction without limit. The code marks dream output (`is_dream_generated`, `origin='dream'`) to break the loop.
- Agent writeback cannot set trust grade `instruction`. Promotion needs a human-confirmed `memory_review` row.
- Notion is a confidential OAuth client with no PKCE, so the callback stashes the grant and needs a same-user confirm step. A residual risk is noted in the plan.
- Cron `*/5` runs idle-promotion, audit export and re-embed in one `scheduled()` handler. It gets crowded.

Docs and code disagree in these places:

- `README.md` "Status" says "v1 skeleton" and lists only v1 pieces. `docs/gap-analysis-2026-08-18.md` says v2 (dream, snapshots, hooks, Notion) and v3 W1 to W5 (wiki, TipTap editor, OKF bundles) are built. The code agrees with the gap analysis.
- `README.md` and `IMPLEMENTATION_PLAN.md` say the dashboard is co-located in `apps/api` and uses `createServerFn`. The code has a separate `brain-dashboard` Worker with a `BRAIN_API` service binding (it does still use `createServerFn`).
- `README.md` says real-Cloudflare measurement is "pending". The Worker is deployed (wrangler vars name live URLs and this session's MCP list includes The Brain tools), but I found no recorded measurements.
- `docs/r2-facade-plan.md` and `docs/notion-integration-plan.md` headers say "no code yet". Both are shipped. The Notion header was fixed, the R2 one may still say it (the gap analysis lists both as stale).
- `apps/api/src/mcp/agent.ts` header says "MINIMAL-BOOT scope: one trivial ping tool". The same file's `init()` builds the full catalog server through `buildMcpServer`. The comment is stale. `buildPingServer` is left over.
- `wrangler.jsonc` comment says only bindings with local emulation are declared. Vectorize, AI and Workflows are declared too.
- `wrangler.jsonc` holds a real D1 `database_id`, KV id, account id and a Clerk test publishable key in the repo. They are identifiers, not secrets, but Harbourmaster should keep them in env files.
- Wiki W6 realtime collab (`WikiRoom` DO) exists only in docs. No code.

## 7. Maturity

- History: 50 commits, 2026-07-02 to 2026-10-03 (last: `15506a1 feat(ai): switch KG extraction to DeepSeek-V4-Flash`). About 47,500 lines of TypeScript in src.
- Tests: 102 test files. Isolation "canary" suites run in real workerd D1 (cross-tenant, FTS leak, MCP sessions, vault, wiki, Notion). `drift.test.ts` guards the generated surfaces. I did not run them.
- CI: none. No `.github/`. `bun check` (biome, tsc, tests, boundary-lint) is a local convention. Real-AI gates are `test.todo`.
- Deployed: yes, API and dashboard on the account above, with Clerk. The Brain MCP server is live as a claude.ai connector in this session.
- Completeness: v1 plan done. v2 done (dream engine, snapshots, hook kit, Notion, add_thought, voice upload). v3 W1 to W5 done, with wiki images added in August. Open: W6 collab, CI and real-AI gates, Gmail and GitHub importers, shard fan-out, Notion write-back, comments and share links.
- Single-user reality: v1 targets 1 to 2 tenants and a $400 monthly cost ceiling. Treat it as a solid one-person system, not a proven multi-customer SaaS.
- Fit risks for reuse: Zod 3 here against Zod 4 in Harbourmaster `packages/services`; Workers AI models are hard-coded; `agents` 0.7.0 and `workers-oauth-provider` 0.8.1 are pinned and will have moved.
