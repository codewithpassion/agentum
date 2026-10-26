import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { mainNavItems, moreNavItems, settingsNavItem } from "./nav-registry.ts";

test("main items appear in order", () => {
  expect(mainNavItems.map((item) => item.label)).toEqual([
    "Desk",
    "Agents",
    "Map",
    "Library",
    "Skills",
    "Machines",
  ]);
  expect(mainNavItems.map((item) => item.to)).toEqual([
    "/desk",
    "/agents",
    "/map",
    "/library",
    "/skills",
    "/machines",
  ]);
});

test("More holds the five old items", () => {
  expect(moreNavItems.map((item) => item.label)).toEqual([
    "Inbox",
    "Sessions",
    "Log",
    "Routines",
    "Triggers",
  ]);
});

test("no route repeats across main, More and settings", () => {
  const targets = [...mainNavItems, ...moreNavItems, settingsNavItem].map(
    (item) => item.to
  );
  expect(new Set(targets).size).toBe(targets.length);
});

test("every item points at a route file", () => {
  const routeFiles = readdirSync(join(import.meta.dir, "../../routes/_app"));
  const firstSegments = new Set(routeFiles.map((file) => file.split(".")[0]));
  for (const item of [...mainNavItems, ...moreNavItems, settingsNavItem]) {
    expect(firstSegments.has(item.to.slice(1))).toBe(true);
  }
});
