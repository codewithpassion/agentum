import { expect, test } from "bun:test";
import {
  artifactHref,
  audienceBadges,
  byLine,
  hasFilters,
  listInput,
  thumbnailSrc,
} from "./artifacts-logic.ts";

test("hrefs", () => {
  expect(artifactHref("x")).toBe("/a/x");
  expect(thumbnailSrc("x")).toBe("/api/artifacts/x/thumbnail");
});

test("audience badges add Link while a link is active", () => {
  expect(audienceBadges({ audience: "private", linkCount: 0 })).toEqual([
    "Private",
  ]);
  expect(audienceBadges({ audience: "workspace", linkCount: 2 })).toEqual([
    "Workspace",
    "Link",
  ]);
});

test("byLine names the agent only when there is one", () => {
  expect(byLine({ agentName: null, ownerName: "Dana" })).toBe("Dana");
  expect(byLine({ agentName: "Scout", ownerName: "Dana" })).toBe(
    "Dana · made by Scout"
  );
  expect(byLine({ agentName: null, ownerName: null })).toBe("Unknown");
});

test("listInput carries only the set filters and the cursor", () => {
  expect(listInput({})).toEqual({});
  expect(
    listInput({ kind: "doc", madeBy: "agent", shared: true }, "c1")
  ).toEqual({ cursor: "c1", kind: "doc", madeBy: "agent", shared: true });
  expect(hasFilters({})).toBe(false);
  expect(hasFilters({ shared: true })).toBe(true);
});
