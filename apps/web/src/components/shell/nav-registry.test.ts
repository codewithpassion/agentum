import { expect, test } from "bun:test";
import { navGroups, settingsNavItem } from "./nav-registry.ts";

test("group labels appear in order", () => {
  expect(navGroups.map((group) => group.label)).toEqual([
    "Work",
    "Automation",
    "Knowledge",
  ]);
});

test("each group has 2 to 4 items", () => {
  for (const group of navGroups) {
    expect(group.items.length).toBeGreaterThanOrEqual(2);
    expect(group.items.length).toBeLessThanOrEqual(4);
  }
});

test("no route repeats across groups and the settings item", () => {
  const targets = [
    ...navGroups.flatMap((group) => group.items.map((item) => item.to)),
    settingsNavItem.to,
  ];
  expect(new Set(targets).size).toBe(targets.length);
});

test("no group item points into settings, machines or connectors", () => {
  const forbidden = ["/settings", "/machines", "/connectors"];
  for (const group of navGroups) {
    for (const item of group.items) {
      for (const prefix of forbidden) {
        expect(item.to.startsWith(prefix)).toBe(false);
      }
    }
  }
});
