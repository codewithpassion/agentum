import { expect, test } from "bun:test";
import { settingsNav } from "./settings-nav.ts";

const allItems = settingsNav.flatMap((group) => group.items);

test("groups appear in order", () => {
  expect(settingsNav.map((group) => group.label)).toEqual([
    "You",
    "Agents run on",
    "Agents can use",
    "Access to Agentum",
    "Jobs",
    "Spend",
  ]);
});

test("paths appear in order", () => {
  expect(allItems.map((item) => item.to)).toEqual([
    "/settings/sign-ins",
    "/settings/model-providers",
    "/settings/machines",
    "/settings/connectors",
    "/settings/secrets",
    "/settings/artifacts",
    "/settings/api-keys",
    "/settings/connected-apps",
    "/settings/agent-connections",
    "/settings/timezone",
    "/settings/spend",
  ]);
});

test("every path starts with /settings/", () => {
  for (const item of allItems) {
    expect(item.to.startsWith("/settings/")).toBe(true);
  }
});

test("no path repeats", () => {
  const paths = allItems.map((item) => item.to);
  expect(new Set(paths).size).toBe(paths.length);
});
