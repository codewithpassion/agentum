# Navigation and settings

Asked for by Dom on 19 Oct 2026: the sidebar and the configuration pages have "no rhyme or reason". This note reviews what exists, proposes a grouped sidebar and one Settings area, and lists the decisions left open. The task that builds it is `docs/tasks/U.10-navigation-settings.md`.

The review is from source on `main` (19 Oct 2026). A dev-server walk-through adds little that the code does not already show.

## Current state

### Sidebar

`apps/web/src/components/shell/app-sidebar.tsx` renders one flat `SidebarMenu` from `navItems` in `nav-registry.ts`. `navItems` concatenates three files in `components/shell/nav/`: `runtime.ts`, `access.ts` and `automation.ts`. These were build lanes, so parallel tasks could each append to their own file without merge conflicts. They were never meant as groups a user sees, and the sidebar shows no group labels.

The result is 15 items in one list, in this order:

| # | Label | Route | What it is | Who uses it | How often | Lane file |
|---|---|---|---|---|---|---|
| 1 | Agents | `/agents` | Agent list, entry to each agent's page and chat | Everyone | Daily | runtime |
| 2 | Sessions | `/sessions` | All chat sessions across agents | Everyone | Daily | runtime |
| 3 | Machines | `/machines` | Enrol and list daemon machines | Admin | Rare (once per machine) | runtime |
| 4 | Anthropic | `/settings/managed-agents` | Workspace Anthropic API key | Admin | Rare (once) | runtime |
| 5 | Model providers | `/settings/model-providers` | Workspace OpenRouter API key | Admin | Rare (once) | runtime |
| 6 | Secrets | `/settings/secrets` | Workspace secrets and their proxy or env rules | Admin | Occasional | runtime |
| 7 | Library | `/library` | Shared files | Everyone | Weekly | runtime |
| 8 | Skills | `/skills` | Skill store | Builders | Weekly | runtime |
| 9 | Log | `/log` | Event log of runs | Everyone | Daily when debugging | runtime |
| 10 | API keys | `/settings/api-keys` | Keys for outside MCP clients to call Harbourmaster | Admin | Rare | access |
| 11 | Connectors | `/connectors` | Outside MCP servers agents can use, plus "your credential" per connector | Admin adds, users connect | Occasional | access |
| 12 | Connected apps | `/settings/connected-apps` | OAuth clients (such as Claude.ai) that connect to Harbourmaster's MCP | Admin | Rare | access |
| 13 | Triggers | `/triggers` | HTTP triggers that start runs, all agents | Builders | Occasional | automation |
| 14 | Routines | `/routines` | Scheduled runs, all agents | Builders | Occasional | automation |
| 15 | Inbox | `/inbox` | Threads where agents post and wait for replies | Everyone | Daily | automation |

The header (`components/header.tsx`) also has a "Home" link to `/`. For a signed-in user `/` redirects to `/agents`, so it repeats the first sidebar item.

### Settings routes

Five routes live under `/settings/` as flat files in `routes/_app/`: `settings.api-keys.tsx`, `settings.connected-apps.tsx`, `settings.managed-agents.tsx`, `settings.model-providers.tsx`, `settings.secrets.tsx`. There is no `settings.tsx` layout, no `/settings` index (it is a 404) and no sub-navigation. Each page is reached only from the main sidebar.

Two workspace admin pages sit outside `/settings/`: `/machines` and `/connectors`.

### Agent page tabs

`components/agent/agent-tabs.ts` lists the tabs on `/agents/$agentId`: Chat, Sessions, Settings, Connectors, Secrets, Skills, Slack, Triggers. Agent-level configuration already lives on the agent:

- Settings: name, instructions, model, machine; archive.
- Connectors: assign workspace connectors to this agent, connect as the agent. Links to `/connectors`.
- Secrets: grant workspace secrets to this agent. Links to `/settings/secrets`.
- Skills: assign and pin skills. Links to `/skills`.
- Slack: connect a Slack app for this agent.
- Triggers: this agent's triggers.

Each "workspace object, granted per agent" pair is consistent: the workspace page creates the thing, the agent tab grants it. The one gap is routines: there is a Triggers tab but no Routines tab, although `routines.list` already takes `agentId` and `RoutineTable` has a `showAgent` prop.

## Problems

1. One flat list of 15 items with no groups. The order follows build lanes, not use: daily items (Agents, Sessions, Inbox, Log) are split up, and Inbox sits under "automation".
2. Workspace settings are mixed into runtime navigation. Six of the 15 items are pages an admin opens once (Machines, Anthropic, Model providers, API keys, Connected apps) or rarely (Secrets), yet they sit between Sessions and Library.
3. No Settings area. `/settings` is a 404, there is no sub-nav, and two admin pages (`/machines`, `/connectors`) use top-level URLs while their siblings use `/settings/...`.
4. Model keys are split across two pages with three names. The Anthropic key lives at route `managed-agents`, nav label "Anthropic", heading "Anthropic", while OpenRouter lives at "Model providers". Both keys are model provider keys, and since U.7 the Anthropic key serves Cloudflare agents too, not only Managed Agents. The two pages are the same form twice (`keyState`, draft, Save and Remove), differing only in `managedKeys` versus `modelKeys({ provider })`.
5. Confusable names. "Connectors" (outside MCP servers that agents call) and "Connected apps" (outside apps that call Harbourmaster) sit next to each other and read as the same thing. "API keys" belongs with "Connected apps" (both are ways in), but nothing says so.
6. No active state. `SidebarMenuButton` takes `isActive`, but `app-sidebar.tsx` never sets it, so the sidebar does not show where you are.
7. The header "Home" link duplicates "Agents".

Agent-level config living outside the agent is mostly not a problem here. The workspace pages create shared objects and the agent tabs grant them. Routines is the one asymmetry (see open decisions).

## Target structure

Grouping, naming and moving only. No new pages except the settings layout and its index redirect.

### Sidebar

```
Work
  Agents            /agents
  Sessions          /sessions
  Inbox             /inbox
  Log               /log
Automation
  Routines          /routines
  Triggers          /triggers
Knowledge
  Library           /library
  Skills            /skills
(footer)
  Settings          /settings  -> /settings/model-providers
```

Groups render with `SidebarGroup` and `SidebarGroupLabel`. Settings sits in `SidebarFooter`, one entry, highlighted on every `/settings/*` page. Every item sets `isActive` from the current route (fuzzy match, so `/agents/abc` highlights Agents).

### Settings area

A layout route `routes/_app/settings.tsx` renders a sub-nav beside an `<Outlet />`. On narrow screens the sub-nav sits above the content. Links use `buttonVariants({ variant: "ghost" })` from `components/ui/button` with `activeProps`, the same pattern as `header.tsx`. No new shadcn component is needed.

```
Settings
  Agents run on
    Model providers   /settings/model-providers   (Anthropic API key + OpenRouter API key)
    Machines          /settings/machines
  Agents can use
    Connectors        /settings/connectors
    Secrets           /settings/secrets
  Access to Harbourmaster
    API keys          /settings/api-keys
    Connected apps    /settings/connected-apps
```

`/settings` redirects to `/settings/model-providers`, the page a new workspace needs first.

Model providers becomes one page with two sections, "Anthropic API key" and "OpenRouter API key", each rendered by one shared form component in `components/model-providers/`. The section heading "Anthropic API key" stays, so the shared missing-key message from U.7 ("Add one in Settings, Anthropic API key.") stays true and its tests do not change.

### Old to new mapping

| Item | Old place | New place | URL change |
|---|---|---|---|
| Agents, Sessions, Inbox, Log | Flat sidebar | Sidebar, Work | None |
| Routines, Triggers | Flat sidebar | Sidebar, Automation | None |
| Library, Skills | Flat sidebar | Sidebar, Knowledge | None |
| Anthropic | Sidebar, `/settings/managed-agents` | Settings, Model providers (section) | Redirect |
| Model providers | Sidebar | Settings, Agents run on | None |
| Machines | Sidebar, `/machines` | Settings, Agents run on | Moved, redirect |
| Connectors | Sidebar, `/connectors` | Settings, Agents can use | Moved, redirect |
| Secrets | Sidebar | Settings, Agents can use | None |
| API keys | Sidebar | Settings, Access to Harbourmaster | None |
| Connected apps | Sidebar | Settings, Access to Harbourmaster | None (the MCP server prints this URL, `server/routes/mcp.ts:225`) |
| Header "Home" | Header | Removed | None |
| Agent tabs | Agent page | Unchanged | None |

### Redirects

Each old route file becomes a redirect-only route with `beforeLoad: () => { throw redirect(...) }`.

| Old URL | New URL | Note |
|---|---|---|
| `/settings` | `/settings/model-providers` | New index, was a 404 |
| `/settings/managed-agents` | `/settings/model-providers` | |
| `/machines` | `/settings/machines` | |
| `/connectors` | `/settings/connectors` | Must forward `connected` and `connect_error` search params, because OAuth state rows created before the deploy still return to `/connectors` |

References to update when Connectors and Machines move:

- `packages/services/src/connector-oauth.ts:165-168`, `defaultReturnTo` returns `"/connectors"` for a user owner; `connector-oauth.test.ts:603` asserts it.
- `routes/_app/connectors.tsx:116`, `returnTo: "/connectors"` (moves with the page).
- `server/routes/oauth-callback.test.ts:337` ("denying access at the provider") uses the default return path and asserts `/connectors?connect_error=access_denied`; it must change. The test at line 173 passes `return_to=/connectors` explicitly and keeps passing.
- `components/agent/tabs/connectors.tsx:399`, link to `/connectors`.
- `components/agent/agent-form.tsx:369`, link to `/machines`.

TanStack `Link to=` is typed against `routeTree.gen.ts`, so a stale path fails typecheck once the route tree is regenerated (`bun run generate-routes` in `apps/web`; the file is gitignored and is not regenerated by `tsc`).

## Open decisions

Each has a recommended default that the task file follows unless Dom says otherwise.

1. Move Connectors and Machines under `/settings/`? Default: yes, with redirects that keep search params. The alternative is to keep their URLs and only move the nav entries, which costs nothing but leaves them outside the settings layout and its sub-nav.
2. Rename "Connected apps"? Default: keep the name. The group heading "Access to Harbourmaster" says which way the connection goes. Alternatives: "OAuth apps" or "MCP clients".
3. Is Connectors a setting or daily work? Users press "Connect" there to add their own credential. Default: Settings, because connecting is a one-time act per person, and agents get connectors on their own Connectors tab.
4. Add a Routines tab on the agent page, matching Triggers? Default: out of scope here, because it is a new feature. It is small (reuse `RoutineTable` with `routines.list({ agentId })`) and could be its own task.
5. Remove the header "Home" link? Default: yes.
6. Rename the agent's "Settings" tab, so it does not share a name with workspace Settings? Default: keep "Settings". Context (the agent page) makes it clear.
7. Should non-admins see Settings? Harbourmaster has no roles yet. Default: everyone sees it, as today.
