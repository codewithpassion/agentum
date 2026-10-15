# Harbourmaster handover

Written 16 October 2026 at the end of the design session. The next session starts implementation with milestone M0.

## Where things stand

The design is finished, reviewed twice, and merged to `main` (commit `e609571`, pushed). No application code for Harbourmaster exists yet. The repo is still the initialised boilerplate: Bun, TanStack Start, Hono, tRPC, D1 with Drizzle, Clerk (already wired, commit `96f8111`), shadcn, deployed to Cloudflare Workers.

Read these before writing code, in this order:

1. `docs/architecture/index.html` is the overview. It covers scope, deferred items, the six seams with type sketches, the data model, where things run, auth, and the decision table for the ten open questions.
2. `docs/architecture/build-plan.html` has the contracts, every milestone with its runnable check, and the three lanes.
3. `docs/architecture/reuse.html` lists every file to copy or borrow, with source paths under `/home/roboto/devel/`.
4. `docs/architecture/review-response.html` explains why the design looks the way it does. Read the round 2 rows when something seems odd.

The brief is `docs/log/2026-10-16-agent-platform-vision.md`. The analyses of the eleven source repos are in `docs/analysis/`. The same four pages are published as a private artifact at https://claude.ai/artifact/7St8ZgCKBSTgmJYZyd9wrU.

## The design in one paragraph

One Worker and one Durable Object class (`MachineRelay`) own agents, sessions, runs, connectors, credentials, triggers, Slack, the inbox, an append-only event log, and a platform MCP server. Agents run on Dom's machines through a Bun daemon (`apps/daemon`). The daemon claims runs over HTTP and runs each one as Claude Code through the Agent SDK, as a separate `hm-agent` Unix user. Each run gets one token for its whole life. The daemon hands it to Claude Code with `query.setMcpServers()`, never on the command line. Connectors are reached through `/api/proxy/:connectorId`, where the Worker injects the right credential. Connector secrets never leave the Worker.

## Dom's decisions

| Question | Decision |
|---|---|
| Who v1 is for | Dom first. Managed Agents stays out of v1. |
| Permission mode | `bypassPermissions` as `hm-agent`, with a `single_user` fallback on boxes without sudo |
| Anthropic credential | The machine's own subscription login for every run, colleagues' runs included |
| Slack | One app per agent, manifest-paste flow. Build the manifest API only if pasting proves too slow. |
| Wiki | Connect The Brain as an MCP connector. No wiki code. |
| Default credential mode | `user_or_agent` |
| Sign-up | Clerk org required, allow-listed orgs only, restricted sign-up on |
| Slack thread sessions | One session per thread |
| Worker-hosted agent loop | Not in v1 |
| Proxy call cap | 5 minutes, to be proven in M3.3 |

## Next step: M0 Foundations

M0 is serial work for one person and should take two to three weeks. It ends when the foundation contracts exist as code with tests and a run goes end to end on a fake runtime. The build plan has the full scope and check for each task.

| Task | What it delivers | Contract |
|---|---|---|
| M0.1 | Workspaces, the principal resolver for all four bearer prefixes, `authz.can()`, `workspaceProcedure`, dev user with an org | C2 |
| M0.2 | Schema split per module, the nine foundation tables, append-only triggers on `events`, the `atomic` write port | C1 |
| M0.3 | Events service with the 64 KB payload cap and R2 overflow | C5 |
| M0.4 | Runs service, `startRun`, fake runtime, queued-run sweep, lease reaper, seed script | C3, C7 |
| M0.5 | AES-GCM secrets, hashed tokens, run token sign and verify | C6, part |
| M0.6 | `packages/protocol` machine frames, `packages/mcp` with the nine tool names | C4, C6 |
| M0.7 | Worker entry with `{ fetch, scheduled }`, `MachineRelay` ping, bindings, wiring split per lane, UI shell, test shim, boundary lint | |
| M0.8 | CI workflow, CLAUDE.md and README updates | |

C1, C4 and C6 freeze at the end of M0. The others can change until the M1 gate.

I'd start with a spike from M0.7 before M0.1: export a Durable Object from `server.ts` and get `curl localhost:3000/api/machines/ping-do` to answer from inside it. Nobody has run a DO under the Cloudflare Vite plugin with TanStack Start in this repo. Every machine milestone depends on it, so it's the riskiest thing in M0. If it fails, the relay design has to change before any contract freezes.

After M0, the solo order is O.1 (staging, half a day), M1 (walking skeleton, use it for a day), M2.1, M3, M7 with M1.6, M5.1 and M5.2, M4, M6, M5.3, M2.2, M2.3.

## Rules that are easy to break

- Services are factories that take `{ db, atomic, ... }` and never read `env`. `apps/web/src/server/compose.ts` builds them.
- Multi-statement writes go through `atomic` from `@repo/db`. It wraps `db.batch` on D1 and `db.transaction` on `bun:sqlite`, because drizzle 0.44.7 has `batch` only on D1.
- Every table except `workspaces` has `workspace_id TEXT NOT NULL` with no default.
- Each module exposes one `exports` subpath, such as `@repo/services/runs`. No barrel files. Biome's `noBarrelFile` is an error, and that repo rule wins over the global "index.ts barrel" rule.
- Every new binding goes in three places in `wrangler.jsonc`: top level, `env.staging` and `env.staging.previews`. DO `migrations` and `triggers.crons` stay top level only.
- A release that creates or renames a DO class goes out with `wrangler deploy`. Cloudflare refuses `versions upload` for those.
- A new service goes in `context.ts` and in the add-clerk template copy under `.claude/skills/add-clerk/templates/`. Otherwise running add-clerk later drops it.
- Do not use Agentum's UI as a source or example. Its backend modules and protocols are fine to copy.
- A copied file comes in with its tests, or it doesn't come in.

## Things nobody has verified yet

Each of these has a named check in the build plan.

- A Durable Object under the Vite plugin plus TanStack Start runs locally (M0.0, 16 Oct 2026). Not yet checked in a deployed Worker or a PR preview.
- Whether `canUseTool` fires under `bypassPermissions`, and whether servers added with `setMcpServers()` are connected before the first turn (M1.4 probes).
- That a run token stays out of `/proc/<pid>/cmdline` (M1.4 live check).
- A 4-minute MCP call held open through the deployed Worker, which decides whether the 5-minute cap holds (M3.3).
- Slack's `apps.manifest.create`. It is optional now, so it only matters if the paste flow is too slow.

## Session setup notes

- `harbourmaster/.claude/settings.local.json` (gitignored) sets `teammateMode: "in-process"`. It also allows reads under `/home/roboto/devel/**` and edits under `docs/**`. Subagents therefore run without tmux panes. Stop idle subagents when they finish.
- The pre-commit hook runs Ultracite. It reformats HTML in `docs/` and fails on lint errors, such as an SVG without a title. Fix the errors rather than skipping the hook.
- The Codex sandbox (bwrap) fails on this host with `loopback: Failed RTM_NEWADDR: Operation not permitted`, so a Codex review cannot read the repo. The round 2 review worked around it by inlining the pages as text. Fix bwrap, or keep inlining, before relying on Codex for code review.
- The Brain wiki has the brief under `projects/harbourmaster`. The architecture lives only in this repo.
