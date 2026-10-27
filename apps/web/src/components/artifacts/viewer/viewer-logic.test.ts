import { expect, test } from "bun:test";
import {
  buildViewerPath,
  byline,
  downloadPath,
  parseVersionSearch,
  shownVersionNumber,
} from "./viewer-logic.ts";

test("parseVersionSearch accepts positive whole numbers", () => {
  expect(parseVersionSearch(3)).toBe(3);
  expect(parseVersionSearch("4")).toBe(4);
  expect(parseVersionSearch("0")).toBeUndefined();
  expect(parseVersionSearch(-1)).toBeUndefined();
  expect(parseVersionSearch("1.5")).toBeUndefined();
  expect(parseVersionSearch("abc")).toBeUndefined();
  expect(parseVersionSearch("")).toBeUndefined();
  expect(parseVersionSearch(undefined)).toBeUndefined();
});

test("shownVersionNumber falls back to the current version", () => {
  const detail = { currentVersion: { number: 5 } } as never;
  expect(shownVersionNumber(detail, undefined)).toBe(5);
  expect(shownVersionNumber(detail, 2)).toBe(2);
});

test("buildViewerPath adds ?v only for an older version", () => {
  expect(buildViewerPath("a1", undefined, 5)).toBe("/a/a1");
  expect(buildViewerPath("a1", 5, 5)).toBe("/a/a1");
  expect(buildViewerPath("a1", 2, 5)).toBe("/a/a1?v=2");
});

test("downloadPath names the version", () => {
  expect(downloadPath("a1", 3)).toBe("/api/artifacts/a1/download?version=3");
});

test("byline falls back to someone and keeps the task only when visible", () => {
  expect(byline({ agentName: null, madeIn: null, ownerName: null })).toEqual({
    agent: null,
    owner: "someone",
    task: null,
  });
  expect(
    byline({
      agentName: "Scribe",
      madeIn: { runId: "r1", sessionId: "s1", title: "Plan" },
      ownerName: "Dom",
    })
  ).toEqual({
    agent: "Scribe",
    owner: "Dom",
    task: { runId: "r1", title: "Plan" },
  });
});
