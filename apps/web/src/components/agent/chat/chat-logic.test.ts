import { describe, expect, test } from "bun:test";
import type { RunStatus } from "@repo/db/shared";
import type { SessionTranscript } from "#/integrations/trpc/types";
import {
  canRetry,
  isRunActive,
  RETRY_AFTER_MS,
  shouldPoll,
  statusLine,
  toChatItems,
} from "./chat-logic";

type Entry = SessionTranscript["entries"][number];
type Run = NonNullable<SessionTranscript["latestRun"]>;

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const MINUTE = 60 * 1000;

const makeRun = (overrides: Partial<Run>): Run =>
  ({
    agentId: "agent-1",
    createdAt: new Date(NOW - 60 * MINUTE).toISOString(),
    error: null,
    finishedAt: null,
    id: "run-1",
    inputText: "hello",
    outputFileIds: [],
    processEndedAt: null,
    resultText: null,
    sessionId: "session-1",
    status: "running",
    ...overrides,
  }) as Run;

const makeEntry = (overrides: Partial<Entry>): Entry =>
  ({
    actor: { id: "actor-1", kind: "user" },
    agentId: "agent-1",
    createdAt: "2026-10-16T11:00:00.000Z",
    id: "entry-1",
    payload: {},
    payloadRef: null,
    runId: "run-1",
    seq: 0,
    sessionId: "session-1",
    type: "message.user",
    workspaceId: "workspace-1",
    ...overrides,
  }) as Entry;

describe("isRunActive", () => {
  test.each([
    ["queued", true],
    ["offered", true],
    ["running", true],
    ["done", false],
    ["failed", false],
    ["cancelled", false],
    ["interrupted", false],
  ] as [RunStatus, boolean][])("%s is active: %p", (status, expected) => {
    expect(isRunActive(status)).toBe(expected);
  });
});

describe("canRetry", () => {
  test("is false for no run", () => {
    expect(canRetry(null, NOW)).toBe(false);
  });

  test("is false for a running run", () => {
    expect(canRetry(makeRun({ status: "running" }), NOW)).toBe(false);
  });

  test("is false for done", () => {
    expect(
      canRetry(
        makeRun({ processEndedAt: "2026-10-16T11:00:00.000Z", status: "done" }),
        NOW
      )
    ).toBe(false);
  });

  test("is false for an interrupted run 9 minutes old with no processEndedAt", () => {
    const createdAt = new Date(NOW - 9 * MINUTE).toISOString();
    expect(canRetry(makeRun({ createdAt, status: "interrupted" }), NOW)).toBe(
      false
    );
  });

  test("is true at exactly 10 minutes with no processEndedAt", () => {
    const createdAt = new Date(NOW - RETRY_AFTER_MS).toISOString();
    expect(canRetry(makeRun({ createdAt, status: "interrupted" }), NOW)).toBe(
      true
    );
  });

  test("uses finishedAt over createdAt for the age", () => {
    const finishedAt = new Date(NOW - 1 * MINUTE).toISOString();
    expect(
      canRetry(
        makeRun({
          createdAt: new Date(NOW - 60 * MINUTE).toISOString(),
          finishedAt,
          status: "interrupted",
        }),
        NOW
      )
    ).toBe(false);
  });

  test("is true one second after the run ended when processEndedAt is set", () => {
    expect(
      canRetry(
        makeRun({
          createdAt: new Date(NOW - 1000).toISOString(),
          processEndedAt: new Date(NOW - 1000).toISOString(),
          status: "interrupted",
        }),
        NOW
      )
    ).toBe(true);
  });
});

describe("shouldPoll", () => {
  test("is false for no run", () => {
    expect(shouldPoll(null, NOW)).toBe(false);
  });

  test("is true for a running run", () => {
    expect(shouldPoll(makeRun({ status: "running" }), NOW)).toBe(true);
  });

  test("is true for a young interrupted run without processEndedAt", () => {
    const createdAt = new Date(NOW - 1 * MINUTE).toISOString();
    expect(shouldPoll(makeRun({ createdAt, status: "interrupted" }), NOW)).toBe(
      true
    );
  });

  test("is false for an interrupted run with processEndedAt", () => {
    expect(
      shouldPoll(
        makeRun({
          processEndedAt: "2026-10-16T11:30:00.000Z",
          status: "interrupted",
        }),
        NOW
      )
    ).toBe(false);
  });

  test("is false for done", () => {
    expect(shouldPoll(makeRun({ status: "done" }), NOW)).toBe(false);
  });
});

describe("statusLine", () => {
  test("is null for no run", () => {
    expect(statusLine(null)).toBeNull();
  });

  test("describes each status", () => {
    expect(statusLine(makeRun({ status: "queued" }))).toBe(
      "Queued, waiting for the machine"
    );
    expect(statusLine(makeRun({ status: "offered" }))).toBe(
      "Queued, waiting for the machine"
    );
    expect(statusLine(makeRun({ status: "running" }))).toBe("Running");
    expect(statusLine(makeRun({ status: "done" }))).toBe("Done");
    expect(statusLine(makeRun({ status: "cancelled" }))).toBe("Cancelled");
  });

  test("includes the error for a failed run", () => {
    expect(
      statusLine(makeRun({ error: "machine went away", status: "failed" }))
    ).toBe("Failed: machine went away");
  });

  test("says only Failed when there is no error", () => {
    expect(statusLine(makeRun({ error: null, status: "failed" }))).toBe(
      "Failed"
    );
  });

  test("warns that the process may still run when processEndedAt is null", () => {
    expect(statusLine(makeRun({ status: "interrupted" }))).toBe(
      "Interrupted. The process may still be running."
    );
  });

  test("says Interrupted once processEndedAt is set", () => {
    expect(
      statusLine(
        makeRun({
          processEndedAt: "2026-10-16T11:30:00.000Z",
          status: "interrupted",
        })
      )
    ).toBe("Interrupted");
  });
});

describe("toChatItems", () => {
  test("keeps entry order and skips unknown types", () => {
    const items = toChatItems([
      makeEntry({ id: "a", payload: { text: "hi" }, type: "message.user" }),
      makeEntry({ id: "b", payload: {}, type: "run.started" }),
      makeEntry({
        id: "c",
        payload: { text: "hello" },
        type: "message.assistant",
      }),
      makeEntry({ id: "d", payload: {}, type: "run.finished" }),
    ]);
    expect(items).toEqual([
      { id: "a", kind: "user", text: "hi" },
      { id: "c", kind: "assistant", text: "hello" },
    ]);
  });

  test("uses empty text when payload text is not a string", () => {
    expect(
      toChatItems([
        makeEntry({ id: "a", payload: { text: 3 }, type: "message.user" }),
        makeEntry({ id: "b", payload: {}, type: "message.assistant" }),
      ])
    ).toEqual([
      { id: "a", kind: "user", text: "" },
      { id: "b", kind: "assistant", text: "" },
    ]);
  });

  test("labels tool entries with name, then tool, then the entry type", () => {
    const items = toChatItems([
      makeEntry({
        id: "a",
        payload: { name: "read_file", path: "x" },
        type: "tool.call",
      }),
      makeEntry({
        id: "b",
        payload: { ok: true, tool: "shell" },
        type: "tool.result",
      }),
      makeEntry({ id: "c", payload: {}, type: "tool.call" }),
    ]);
    expect(items).toEqual([
      {
        detail: JSON.stringify({ name: "read_file", path: "x" }, null, 2),
        id: "a",
        kind: "tool",
        label: "read_file",
      },
      {
        detail: JSON.stringify({ ok: true, tool: "shell" }, null, 2),
        id: "b",
        kind: "tool",
        label: "shell",
      },
      {
        detail: "{}",
        id: "c",
        kind: "tool",
        label: "tool.call",
      },
    ]);
  });

  test("shows a marker instead of text when the message is oversized", () => {
    expect(
      toChatItems([
        makeEntry({
          id: "a",
          payload: {},
          payloadRef: "blob/key",
          type: "message.user",
        }),
      ])
    ).toEqual([{ id: "a", kind: "user", text: "(content too large to show)" }]);
  });

  test("shows a marker instead of detail when a tool payload is oversized", () => {
    expect(
      toChatItems([
        makeEntry({
          id: "a",
          payload: {},
          payloadRef: "blob/key",
          type: "tool.result",
        }),
      ])
    ).toEqual([
      {
        detail: "(content too large to show)",
        id: "a",
        kind: "tool",
        label: "tool.result",
      },
    ]);
  });
});
