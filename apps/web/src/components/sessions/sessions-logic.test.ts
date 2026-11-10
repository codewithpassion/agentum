import { expect, test } from "bun:test";
import {
  lastActivity,
  ORIGIN_LABELS,
  ORIGIN_VALUES,
  originLabel,
  sessionTitle,
  statusLabel,
} from "./sessions-logic.ts";

test("every origin value has a label", () => {
  expect(ORIGIN_VALUES.map((origin) => ORIGIN_LABELS[origin])).toEqual([
    "UI",
    "Slack",
    "Inbox",
    "Trigger",
    "Routine",
    "MCP",
    "Mail",
    "Q&A",
    "A2A",
    "Artifact",
  ]);
});

test("a private Slack session reads as a DM and a shared one as a thread", () => {
  expect(originLabel({ origin: "slack", private: true })).toBe("Slack DM");
  expect(originLabel({ origin: "slack", private: false })).toBe("Slack thread");
});

test("a non-Slack origin shows its label whatever the private flag", () => {
  expect(originLabel({ origin: "ui", private: false })).toBe("UI");
  expect(originLabel({ origin: "inbox", private: true })).toBe("Inbox");
  expect(originLabel({ origin: "trigger", private: false })).toBe("Trigger");
  expect(originLabel({ origin: "routine", private: false })).toBe("Routine");
  expect(originLabel({ origin: "mcp", private: true })).toBe("MCP");
});

test("an unknown origin is returned as is", () => {
  expect(originLabel({ origin: "carrier-pigeon", private: false })).toBe(
    "carrier-pigeon"
  );
  expect(originLabel({ origin: "", private: true })).toBe("");
});

test("a session with no runs reads as No runs", () => {
  expect(statusLabel(null)).toBe("No runs");
});

test("every run status has a label, and queued and offered both read as Queued", () => {
  expect(statusLabel("queued")).toBe("Queued");
  expect(statusLabel("offered")).toBe("Queued");
  expect(statusLabel("running")).toBe("Running");
  expect(statusLabel("done")).toBe("Done");
  expect(statusLabel("failed")).toBe("Failed");
  expect(statusLabel("cancelled")).toBe("Cancelled");
  expect(statusLabel("interrupted")).toBe("Interrupted");
});

test("last activity is the last run when there is one, else the creation time", () => {
  expect(
    lastActivity({
      createdAt: "2026-10-01T09:00:00.000Z",
      lastRunAt: "2026-10-02T10:00:00.000Z",
    })
  ).toBe("2026-10-02T10:00:00.000Z");
  expect(
    lastActivity({ createdAt: "2026-10-01T09:00:00.000Z", lastRunAt: null })
  ).toBe("2026-10-01T09:00:00.000Z");
});

test("the session title is the trimmed first message", () => {
  expect(
    sessionTitle({
      agentName: "Ops",
      createdAt: "2026-10-01T09:00:00.000Z",
      title: "  Plan the rollout  ",
    })
  ).toBe("Plan the rollout");
});

test("an empty or blank title falls back to the agent name and the creation time", () => {
  const createdAt = "2026-10-01T09:05:00.000Z";
  expect(sessionTitle({ agentName: "Ops", createdAt, title: "" })).toBe(
    "Ops, 2026-10-01 09:05 UTC"
  );
  expect(sessionTitle({ agentName: "Ops", createdAt, title: " \t\n " })).toBe(
    "Ops, 2026-10-01 09:05 UTC"
  );
});
