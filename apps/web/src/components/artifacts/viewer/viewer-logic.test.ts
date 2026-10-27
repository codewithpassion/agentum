import { expect, test } from "bun:test";
import {
  buildViewerPath,
  byline,
  canPromote,
  downloadPath,
  parseVersionSearch,
  promoteButton,
  shownVersionNumber,
  versionOptionLabel,
  versionStatusBadge,
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

test("versionStatusBadge names anything but published", () => {
  expect(versionStatusBadge("published")).toBeNull();
  expect(versionStatusBadge("proposed")).toBe("Proposed");
  expect(versionStatusBadge("rejected")).toBe("rejected");
});

test("versionOptionLabel marks versions that are not published", () => {
  expect(versionOptionLabel({ number: 2, status: "published" })).toBe("v2");
  expect(versionOptionLabel({ number: 3, status: "proposed" })).toBe(
    "v3 (proposed)"
  );
});

test("promoteButton gives the label and disabled flag for each state", () => {
  expect(promoteButton("idle")).toEqual({ disabled: false, label: "Promote" });
  expect(promoteButton("working")).toEqual({
    disabled: true,
    label: "Promoting...",
  });
  expect(promoteButton("waiting")).toEqual({
    disabled: true,
    label: "Waiting for approval",
  });
});

test("canPromote needs a manager and a proposed version", () => {
  expect(canPromote({ canManage: true }, { status: "proposed" })).toBe(true);
  expect(canPromote({ canManage: false }, { status: "proposed" })).toBe(false);
  expect(canPromote({ canManage: true }, { status: "published" })).toBe(false);
  expect(canPromote({ canManage: true }, undefined)).toBe(false);
});
