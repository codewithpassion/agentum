import { describe, expect, test } from "bun:test";
import type { RunStatus } from "@repo/db/shared";
import type { SessionTranscript } from "#/integrations/trpc/types";
import {
  type ChatItem,
  canRetry,
  collectFileIds,
  fileIdsOfRun,
  isRunActive,
  MAX_ATTACHMENTS,
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
      { fileIds: [], id: "a", kind: "user", text: "hi" },
      { fileIds: [], id: "c", kind: "assistant", text: "hello" },
    ]);
  });

  test("uses empty text when payload text is not a string", () => {
    expect(
      toChatItems([
        makeEntry({ id: "a", payload: { text: 3 }, type: "message.user" }),
        makeEntry({ id: "b", payload: {}, type: "message.assistant" }),
      ])
    ).toEqual([
      { fileIds: [], id: "a", kind: "user", text: "" },
      { fileIds: [], id: "b", kind: "assistant", text: "" },
    ]);
  });

  test("takes fileIds from a user message", () => {
    expect(
      toChatItems([
        makeEntry({
          id: "a",
          payload: { fileIds: ["file-1", "file-2"], text: "see" },
          type: "message.user",
        }),
      ])
    ).toEqual([
      { fileIds: ["file-1", "file-2"], id: "a", kind: "user", text: "see" },
    ]);
  });

  test("gives an empty fileIds when the user payload's fileIds is not an array", () => {
    expect(
      toChatItems([
        makeEntry({
          id: "a",
          payload: { fileIds: "file-1", text: "x" },
          type: "message.user",
        }),
        makeEntry({ id: "b", payload: { text: "y" }, type: "message.user" }),
      ]).map((item) => ("fileIds" in item ? item.fileIds : null))
    ).toEqual([[], []]);
  });

  test("keeps only the string elements of fileIds", () => {
    expect(
      toChatItems([
        makeEntry({
          id: "a",
          payload: { fileIds: ["file-1", 2, null, { id: "x" }, "file-3"] },
          type: "message.user",
        }),
      ])
    ).toEqual([
      { fileIds: ["file-1", "file-3"], id: "a", kind: "user", text: "" },
    ]);
  });

  test("gives assistant messages no fileIds even if the payload has some", () => {
    expect(
      toChatItems([
        makeEntry({
          id: "a",
          payload: { fileIds: ["file-1"], text: "done" },
          type: "message.assistant",
        }),
      ])
    ).toEqual([{ fileIds: [], id: "a", kind: "assistant", text: "done" }]);
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
    ).toEqual([
      {
        fileIds: [],
        id: "a",
        kind: "user",
        text: "(content too large to show)",
      },
    ]);
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

describe("fileIdsOfRun", () => {
  test("returns the fileIds of the user message for that run", () => {
    const entries = [
      makeEntry({
        id: "a",
        payload: { fileIds: ["file-1"], text: "first" },
        runId: "run-1",
        type: "message.user",
      }),
      makeEntry({
        id: "b",
        payload: { fileIds: ["file-2", "file-3"], text: "second" },
        runId: "run-2",
        type: "message.user",
      }),
    ];
    expect(fileIdsOfRun(entries, "run-2")).toEqual(["file-2", "file-3"]);
  });

  test("ignores the assistant reply and tool entries of the run", () => {
    const entries = [
      makeEntry({
        id: "a",
        payload: { fileIds: ["file-9"] },
        runId: "run-1",
        type: "tool.call",
      }),
      makeEntry({
        id: "b",
        payload: { fileIds: ["file-8"] },
        runId: "run-1",
        type: "message.assistant",
      }),
      makeEntry({
        id: "c",
        payload: { fileIds: ["file-1"] },
        runId: "run-1",
        type: "message.user",
      }),
    ];
    expect(fileIdsOfRun(entries, "run-1")).toEqual(["file-1"]);
  });

  test("keeps only string elements, and gives [] for a non-array fileIds", () => {
    const entries = [
      makeEntry({
        id: "a",
        payload: { fileIds: ["file-1", 7, true, null] },
        runId: "run-1",
        type: "message.user",
      }),
      makeEntry({
        id: "b",
        payload: { fileIds: "file-2" },
        runId: "run-2",
        type: "message.user",
      }),
    ];
    expect(fileIdsOfRun(entries, "run-1")).toEqual(["file-1"]);
    expect(fileIdsOfRun(entries, "run-2")).toEqual([]);
  });

  test("returns [] when the run has no user message", () => {
    expect(fileIdsOfRun([], "run-1")).toEqual([]);
  });
});

describe("collectFileIds", () => {
  test("gathers user and assistant file ids, then the output files, without repeats", () => {
    const items = toChatItems([
      makeEntry({
        id: "a",
        payload: { fileIds: ["file-2", "file-1"] },
        type: "message.user",
      }),
      makeEntry({
        id: "b",
        payload: { fileIds: ["file-1"] },
        type: "message.user",
      }),
      makeEntry({ id: "c", payload: {}, type: "message.assistant" }),
    ]);
    expect(collectFileIds(items, ["file-3", "file-2", "file-4"])).toEqual([
      "file-2",
      "file-1",
      "file-3",
      "file-4",
    ]);
  });

  test("skips tool items", () => {
    const items: ChatItem[] = [
      { detail: "{}", id: "t", kind: "tool", label: "shell" },
      { fileIds: ["file-1"], id: "u", kind: "user", text: "" },
    ];
    expect(collectFileIds(items, [])).toEqual(["file-1"]);
  });

  test("returns [] when nothing is shown", () => {
    expect(collectFileIds([], [])).toEqual([]);
  });
});

describe("MAX_ATTACHMENTS", () => {
  test("is 20, the server's input file limit", () => {
    expect(MAX_ATTACHMENTS).toBe(20);
  });
});
