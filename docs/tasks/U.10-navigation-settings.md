---
id: U.10
title: Group the sidebar and gather workspace settings into one Settings area
milestone: U
size: M
status: in_progress
depends_on: []
branch: task/U.10-navigation-settings
---

Asked for by Dom on 19 Oct 2026: the sidebar and configuration pages have "no rhyme or reason". The review and target structure are in `docs/analysis/navigation-and-settings.md`. In short: the sidebar is one flat list of 15 items ordered by build lane, workspace settings sit between daily pages, `/settings` is a 404 with no sub-nav, the Anthropic key page is named three ways, and Machines and Connectors use top-level URLs.

This task groups, renames and moves. It adds no feature beyond a settings layout with a sub-nav and redirects for moved URLs. Use only components already in `apps/web/src/components/ui/` and never edit files there. Paths below are relative to `apps/web/src/` unless they start with `packages/`.

Target sidebar: Work (Agents, Sessions, Inbox, Log), Automation (Routines, Triggers), Knowledge (Library, Skills), and one Settings entry in the sidebar footer. Target settings sub-nav: "Agents run on" (Model providers, Machines), "Agents can use" (Connectors, Secrets), "Access to Harbourmaster" (API keys, Connected apps). `/settings` redirects to `/settings/model-providers`.

`routeTree.gen.ts` is gitignored and `tsc` does not regenerate it. Every unit that adds, renames or removes a route file runs `bun run generate-routes` in `apps/web` before `bun run typecheck`.

## Scope

Units run in waves. Units in the same wave touch disjoint files and can run at the same time. A wave starts when the one before it is in.

### Wave 1

1. Shared provider key form. Create `components/model-providers/key-state.ts` exporting `keyState(status: { configured: boolean; hint: string | null; updatedAt: string | null }): string`, copied word for word from `routes/_app/settings.model-providers.tsx` (do not edit that file; unit 6 does). Create `components/model-providers/key-state.test.ts` with cases for no key, a key with `updatedAt`, and a key without `updatedAt` ("recently"). Create `components/model-providers/provider-key-form.tsx` exporting `ProviderKeyForm` with props `{ title: string; description: string; inputId: string; placeholder: string; status: { configured; hint; updatedAt }; onSave: (apiKey: string) => Promise<unknown>; onRemove: () => Promise<unknown> }`. It holds the draft, busy and error state, the `<h2>` title, description, `keyState` line, the `Field`/`Input` form, and the Save key and Remove key buttons, as both settings pages do today. It shows the same toasts ("Key saved", "Key removed"). Check: `bun test src/components/model-providers` in `apps/web`, then `bun run check`.

2. Move Connectors to `/settings/connectors`. Create `components/connectors/connect-search.ts` exporting the `searchSchema` now in `routes/_app/connectors.tsx` (as `connectSearchSchema`). Create `routes/_app/settings.connectors.tsx` with the current page, route id `"/_app/settings/connectors"`, `validateSearch` using `connectSearchSchema`, and `returnTo: "/settings/connectors"` in `connectHref`. Replace `routes/_app/connectors.tsx` with a redirect-only route: same `validateSearch`, and `beforeLoad: ({ search }) => { throw redirect({ to: "/settings/connectors", search }); }`, so `?connected=1` and `?connect_error=...` survive. Check: `bun run generate-routes && bun run typecheck` in `apps/web`, then `bun run check`.

3. Move Machines to `/settings/machines`. Create `routes/_app/settings.machines.tsx` with the current page from `routes/_app/machines.tsx`, route id `"/_app/settings/machines"`. Replace `routes/_app/machines.tsx` with a redirect-only route: `beforeLoad: () => { throw redirect({ to: "/settings/machines" }); }`. Check: `bun run generate-routes && bun run typecheck` in `apps/web`, then `bun run check`.

4. OAuth default return path. In `packages/services/src/connector-oauth.ts`, change `defaultReturnTo` for a user owner from `"/connectors"` to `"/settings/connectors"`. In `packages/services/src/connector-oauth.test.ts`, update the assertion `returnTo: "/connectors"` (around line 603) to the new path. In `apps/web/src/server/routes/oauth-callback.test.ts`, the "denying access at the provider" test (around line 337) starts without `return_to`, so it uses the default: change its expected location to `"/settings/connectors?connect_error=access_denied"`. Leave the `isSameOriginPath("/connectors")` case and the test around line 173, which pass an explicit path. Check: `bun test src/connector-oauth.test.ts` in `packages/services` and `bun test src/server/routes/oauth-callback.test.ts` in `apps/web`, then `bun run check`.

5. Remove the header Home link. In `components/header.tsx`, delete the `<div>` that holds the single "Home" `Link` (signed-in users land on `/agents` from `/` anyway). Keep the logo link. Keep the `.nav-link` rules in `styles.css`, because `integrations/clerk/header-user.tsx` still uses them. Check: `bun run check`.

### Wave 2 (after units 1, 2 and 3)

6. One Model providers page. Rewrite `routes/_app/settings.model-providers.tsx`: the loader fetches `getTrpc().managedKeys.status.query()` and `getTrpc().modelKeys.status.query({ provider: "openrouter" })` with `Promise.all` and keeps the existing UNAUTHORIZED redirect. The page has `<h1>Model providers</h1>` and two `ProviderKeyForm`s. First "Anthropic API key", description "Cloudflare agents and Managed Agents both run on your workspace's own Anthropic API key. The key is stored encrypted and is never shown again; only its last four characters are.", placeholder `sk-ant-...`, saving with `managedKeys.set` and removing with `managedKeys.remove`. Second "OpenRouter API key" with today's text and `modelKeys` calls. Each `onSave`/`onRemove` ends with `router.invalidate()`. Replace `routes/_app/settings.managed-agents.tsx` with a redirect-only route to `/settings/model-providers`. Keep the heading "Anthropic API key", so the missing-key message in `packages/services/src/managed/keys.ts` and `components/agent/agent-form.tsx:310` stays true; change neither. Check: `bun run generate-routes && bun run typecheck` in `apps/web`, `bun test src/components/model-providers`, then `bun run check`.

7. In-app links to moved pages. In `components/agent/tabs/connectors.tsx`, change `<Link to="/connectors">` to `/settings/connectors`. In `components/agent/agent-form.tsx`, change `<Link to="/machines">` to `/settings/machines`. Then `grep -rn '"/connectors"\|"/machines"\|/settings/managed-agents' apps/web/src --include=*.ts --include=*.tsx` must show no hits outside `routes/_app/connectors.tsx`, `routes/_app/machines.tsx` and `routes/_app/settings.managed-agents.tsx`. Check: `bun run typecheck` in `apps/web`, then `bun run check`. Disjoint from unit 6 and 8.

8. Settings nav data. Create `components/settings/settings-nav.ts` exporting `interface SettingsNavItem { label: string; to: string }`, `interface SettingsNavGroup { label: string; items: readonly SettingsNavItem[] }` and `settingsNav: readonly SettingsNavGroup[]` with exactly: "Agents run on" (Model providers `/settings/model-providers`, Machines `/settings/machines`), "Agents can use" (Connectors `/settings/connectors`, Secrets `/settings/secrets`), "Access to Harbourmaster" (API keys `/settings/api-keys`, Connected apps `/settings/connected-apps`). Create `components/settings/settings-nav.test.ts` asserting the group labels in order, the six paths in order, that every path starts with `/settings/`, and that no path repeats. Check: `bun test src/components/settings` in `apps/web`, then `bun run check`.

### Wave 3 (after unit 8)

9. Settings layout and index. Create `routes/_app/settings.tsx`, route `"/_app/settings"`, whose component renders a two-column layout: on `md` and up a left `<nav aria-label="Settings">` about `w-56` wide, below `md` the nav above the content; the content column is `min-w-0 flex-1` with `<Outlet />`. The nav shows each `settingsNav` group as a small muted label followed by its items as `Link`s with `className={buttonVariants({ variant: "ghost", className: "w-full justify-start" })}` and `activeProps={{ className: "bg-accent text-accent-foreground" }}`. Create `routes/_app/settings.index.tsx`, route `"/_app/settings/"`, with `beforeLoad: () => { throw redirect({ to: "/settings/model-providers" }); }`. Check: `bun run generate-routes && bun run typecheck` in `apps/web`, then `bun run check`.

### Wave 4 (after unit 9)

10. Grouped sidebar. Rewrite `components/shell/nav-registry.ts`: keep `NavItem`, add `interface NavGroup { id: string; label: string; items: readonly NavItem[] }`, export `navGroups: readonly NavGroup[]` with Work (Agents `/agents`, Sessions `/sessions`, Inbox `/inbox`, Log `/log`), Automation (Routines `/routines`, Triggers `/triggers`), Knowledge (Library `/library`, Skills `/skills`), reusing today's icons and ids, and export `settingsNavItem: NavItem` (icon `Settings` from lucide-react, id `settings`, label "Settings", to `/settings`). Remove `navItems`. Delete `components/shell/nav/access.ts`, `nav/automation.ts` and `nav/runtime.ts`. Rewrite `components/shell/app-sidebar.tsx` to render one `SidebarGroup` with a `SidebarGroupLabel` per group, and `settingsNavItem` in a `SidebarFooter` (all from `#/components/ui/sidebar`). Read `const pathname = useRouterState({ select: (state) => state.location.pathname })` once, and give each `SidebarMenuButton` `isActive={pathname === item.to || pathname.startsWith(\`${item.to}/\`)}`, so `/agents/abc` highlights Agents and every `/settings/*` page highlights Settings. Create `components/shell/nav-registry.test.ts` asserting the group labels in order, that each group has 2 to 4 items, that no `to` repeats across groups and the settings item, and that no group item's `to` starts with `/settings`, `/machines` or `/connectors`. Check: `bun test src/components/shell` in `apps/web`, `bun run typecheck`, then `bun run check`.

## Check

- Unit tests: `key-state.test.ts`, `settings-nav.test.ts`, `nav-registry.test.ts` and the updated `connector-oauth.test.ts` pass.
- Browser, with dev login on a local dev server. In the worktree's `apps/web` run `bunx wrangler d1 migrations apply DB --local && bunx vite dev --port <free port>`, logging to `/home/roboto/devel/harbourmaster-wt/tmp/U.10/`, sign in through "Dev login (local only)" on `/login`, and stop the server by its PID when done. Confirm:
  - The sidebar shows Work, Automation and Knowledge with their items, and Settings in the footer. The current page is highlighted, including on `/agents/<id>` and on every settings page.
  - The header has no Home link.
  - `/settings` lands on Model providers, which shows both the Anthropic API key and OpenRouter API key sections. Saving and removing a key in each works.
  - The settings sub-nav reaches all six pages, grouped as in Scope, and marks the current one.
  - `/settings/managed-agents`, `/machines` and `/connectors` redirect to their new pages. `/connectors?connected=1` lands on `/settings/connectors?connected=1` and shows "Connected.".
  - The agent page links (Connectors tab to the Connectors page, Secrets tab to Secrets, the new-agent form's "Enrol a machine") open the settings pages.
  - At phone width the settings sub-nav sits above the content with no horizontal scroll.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-19: added at Dom's request.
- 2026-10-19: dispatched with the analysis defaults.
