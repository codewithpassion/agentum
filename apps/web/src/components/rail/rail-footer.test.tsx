import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsIndex } from "#/components/settings/settings-index";
import { settingsNav } from "#/components/settings/settings-nav";
import { RailMenuTrigger } from "#/components/shell/header-menu-slot";
import { footerCurrent, RailFooter, settingsHref } from "./rail-footer.tsx";
import { findShortcut } from "./rail-header-actions.tsx";
import { WorkingList } from "./rail-working.tsx";
import { WorkspaceSettingsItem } from "./workspace-menu.tsx";
import { isActiveAdmin } from "./workspace-menu-logic.ts";

const noop = () => undefined;
const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>{node}</RouterContextProvider>
  );

test("footer current state follows routes and the Apps filter", () => {
  for (const [path, search, current] of [
    ["/agents", {}, "Agents"],
    ["/agents/a", {}, "Agents"],
    ["/artifacts", { kind: "app" }, "Apps"],
    ["/artifacts", {}, null],
    ["/library/folder", {}, "Files"],
    ["/settings", {}, "Settings"],
    ["/settings/secrets", {}, "Settings"],
    ["/desk", { item: "a" }, null],
    ["/agents-other", {}, null],
  ] as const) {
    expect(footerCurrent({ pathname: path, search })).toBe(current);
  }
});

test("admins get four icon tabs; members get three and no Settings", () => {
  const admin = render(
    <RailFooter admin isMobile={false} onNavigate={noop} onOpenFind={noop} />
  );
  expect(admin).toContain('href="/settings/model-providers"');
  expect(admin.match(/<svg/g)).toHaveLength(4);
  expect(admin).not.toContain("Everything");
  const member = render(
    <RailFooter
      admin={false}
      isMobile={false}
      onNavigate={noop}
      onOpenFind={noop}
    />
  );
  expect(member.match(/<a /g)).toHaveLength(3);
  expect(member).not.toContain("Settings");
});

test("phone footer has Find and opens the Settings index", () => {
  const html = render(
    <RailFooter admin isMobile onNavigate={noop} onOpenFind={noop} />
  );
  expect(html).toContain('href="/settings"');
  expect(html).toContain(">Find</button>");
  expect(html).not.toContain("kbd");
});

test("header shortcut follows the platform", () => {
  expect(findShortcut("MacIntel")).toBe("⌘K");
  expect(findShortcut("Win32")).toBe("Ctrl K");
  expect(findShortcut("Linux x86_64")).toBe("Ctrl K");
});

test("Working caps at three and links to Every task", () => {
  const runs = Array.from({ length: 5 }, (_, i) => ({
    agentId: "a",
    agentName: "Agent",
    id: String(i),
    mine: true,
    passedOnBy: null,
    status: "Running",
    title: `Task ${i}`,
  }));
  const html = render(<WorkingList onNavigate={noop} runs={runs} />);
  expect(html).toContain("Task 2");
  expect(html).not.toContain("Task 3");
  expect(html).toContain("View all 5 running");
  expect(html).toContain('href="/sessions"');
  expect(render(<WorkingList onNavigate={noop} runs={[]} />)).toBe("");
});

test("phone rail trigger names and displays its waiting count", () => {
  const html = renderToStaticMarkup(
    <RailMenuTrigger count={11} onClick={noop} />
  );
  expect(html).toContain('aria-label="Open rail, 11 need you"');
  expect(html).toContain(">11</span>");
});

test("phone Settings index lists every nav group and Members", () => {
  const html = render(<SettingsIndex onMembers={noop} />);
  for (const group of settingsNav) {
    expect(html).toContain(group.label);
    for (const item of group.items) {
      expect(html).toContain(`href="${item.to}"`);
    }
  }
  expect(html).toContain("Workspace");
  expect(html).toContain("Members");
});

test("Settings destination follows the viewport", () => {
  expect(settingsHref(false)).toBe("/settings/model-providers");
  expect(settingsHref(true)).toBe("/settings");
});

test("non-admins get no Settings workspace menu item", () => {
  const admin = isActiveAdmin({
    activeOrgId: "org",
    mine: [{ clerkOrgId: "org", role: "org:member", workspaceId: "ws" }],
  });
  expect(admin).toBe(false);
  expect(
    renderToStaticMarkup(
      <WorkspaceSettingsItem admin={admin} onSelect={noop} />
    )
  ).toBe("");
});
