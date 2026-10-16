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
        input: null,
        kind: "tool",
        label: "read_file",
        output: null,
      },
      {
        detail: JSON.stringify({ ok: true, tool: "shell" }, null, 2),
        id: "b",
        input: null,
        kind: "tool",
        label: "shell",
        output: null,
      },
      {
        detail: "{}",
        id: "c",
        input: null,
        kind: "tool",
        label: "tool.call",
        output: null,
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
        input: null,
        kind: "tool",
        label: "tool.result",
        output: null,
      },
    ]);
  });
});

describe("toChatItems tool input and output", () => {
  test("joins a call and its result into one item", () => {
    const callPayload = {
      input: { path: "a.md" },
      name: "read",
      toolUseId: "t1",
    };
    expect(
      toChatItems([
        makeEntry({ id: "call", payload: callPayload, type: "tool.call" }),
        makeEntry({
          id: "result",
          payload: { ok: true, output: "file body", toolUseId: "t1" },
          type: "tool.result",
        }),
      ])
    ).toEqual([
      {
        detail: JSON.stringify(callPayload, null, 2),
        id: "call",
        input: JSON.stringify({ path: "a.md" }, null, 2),
        kind: "tool",
        label: "read",
        output: "file body",
      },
    ]);
  });

  test("gives a call with no result a null output", () => {
    expect(
      toChatItems([
        makeEntry({
          id: "call",
          payload: { input: "ls", name: "shell", toolUseId: "t1" },
          type: "tool.call",
        }),
      ])
    ).toEqual([
      {
        detail: JSON.stringify(
          { input: "ls", name: "shell", toolUseId: "t1" },
          null,
          2
        ),
        id: "call",
        input: '"ls"',
        kind: "tool",
        label: "shell",
        output: null,
      },
    ]);
  });

  test("gives a null input when the call payload has no input", () => {
    expect(
      toChatItems([
        makeEntry({
          id: "call",
          payload: { name: "shell" },
          type: "tool.call",
        }),
      ])[0]
    ).toMatchObject({ input: null, output: null });
  });

  test("stringifies a paired output that is not a string", () => {
    expect(
      toChatItems([
        makeEntry({
          id: "call",
          payload: { name: "shell", toolUseId: "t1" },
          type: "tool.call",
        }),
        makeEntry({
          id: "result",
          payload: { output: { lines: 2 }, toolUseId: "t1" },
          type: "tool.result",
        }),
      ])
    ).toEqual([
      {
        detail: JSON.stringify({ name: "shell", toolUseId: "t1" }, null, 2),
        id: "call",
        input: null,
        kind: "tool",
        label: "shell",
        output: JSON.stringify({ lines: 2 }, null, 2),
      },
    ]);
  });

  test("gives a paired result with no output a null output", () => {
    expect(
      toChatItems([
        makeEntry({
          id: "call",
          payload: { name: "shell", toolUseId: "t1" },
          type: "tool.call",
        }),
        makeEntry({
          id: "result",
          payload: { ok: true, toolUseId: "t1" },
          type: "tool.result",
        }),
      ]).map((item) => (item.kind === "tool" ? item.output : null))
    ).toEqual([null]);
  });

  test("gives the first call the result when two calls share a toolUseId", () => {
    const items = toChatItems([
      makeEntry({
        id: "a",
        payload: { name: "shell", toolUseId: "t1" },
        type: "tool.call",
      }),
      makeEntry({
        id: "b",
        payload: { name: "shell", toolUseId: "t1" },
        type: "tool.call",
      }),
      makeEntry({
        id: "r",
        payload: { output: "x", toolUseId: "t1" },
        type: "tool.result",
      }),
    ]);
    expect(
      items.map((item) => (item.kind === "tool" ? [item.id, item.output] : []))
    ).toEqual([
      ["a", "x"],
      ["b", null],
    ]);
  });

  test("pairs each result with one call, in order", () => {
    const items = toChatItems([
      makeEntry({
        id: "a",
        payload: { name: "shell", toolUseId: "t1" },
        type: "tool.call",
      }),
      makeEntry({
        id: "ra",
        payload: { output: "1", toolUseId: "t1" },
        type: "tool.result",
      }),
      makeEntry({
        id: "b",
        payload: { name: "shell", toolUseId: "t1" },
        type: "tool.call",
      }),
      makeEntry({
        id: "rb",
        payload: { output: "2", toolUseId: "t1" },
        type: "tool.result",
      }),
    ]);
    expect(
      items.map((item) => (item.kind === "tool" ? [item.id, item.output] : []))
    ).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  test("does not pair a result that comes before its call", () => {
    expect(
      toChatItems([
        makeEntry({
          id: "result",
          payload: { output: "early", toolUseId: "t1" },
          type: "tool.result",
        }),
        makeEntry({
          id: "call",
          payload: { name: "shell", toolUseId: "t1" },
          type: "tool.call",
        }),
      ])
    ).toEqual([
      {
        detail: JSON.stringify({ output: "early", toolUseId: "t1" }, null, 2),
        id: "result",
        input: null,
        kind: "tool",
        label: "tool.result",
        output: "early",
      },
      {
        detail: JSON.stringify({ name: "shell", toolUseId: "t1" }, null, 2),
        id: "call",
        input: null,
        kind: "tool",
        label: "shell",
        output: null,
      },
    ]);
  });

  test("keeps a lone result as its own item, with its string output", () => {
    expect(
      toChatItems([
        makeEntry({
          id: "r1",
          payload: { output: "done", toolUseId: "t9" },
          type: "tool.result",
        }),
        makeEntry({
          id: "r2",
          payload: { output: 5 },
          type: "tool.result",
        }),
      ]).map((item) =>
        item.kind === "tool" ? [item.id, item.input, item.output] : []
      )
    ).toEqual([
      ["r1", null, "done"],
      ["r2", null, null],
    ]);
  });

  test("shows the marker instead of input and output when a call is oversized", () => {
    expect(
      toChatItems([
        makeEntry({
          id: "call",
          payload: {},
          payloadRef: "blob/key",
          type: "tool.call",
        }),
      ])
    ).toEqual([
      {
        detail: "(content too large to show)",
        id: "call",
        input: null,
        kind: "tool",
        label: "tool.call",
        output: null,
      },
    ]);
  });

  test("shows the marker as output when the paired result is oversized", () => {
    expect(
      toChatItems([
        makeEntry({
          id: "call",
          payload: { name: "shell", toolUseId: "t1" },
          type: "tool.call",
        }),
        makeEntry({
          id: "result",
          payload: { toolUseId: "t1" },
          payloadRef: "blob/key",
          type: "tool.result",
        }),
      ]).map((item) => (item.kind === "tool" ? item.output : null))
    ).toEqual(["(content too large to show)"]);
  });

  test("keeps collectFileIds the same when tool items are paired", () => {
    const items = toChatItems([
      makeEntry({
        id: "u",
        payload: { fileIds: ["file-1"], text: "see" },
        type: "message.user",
      }),
      makeEntry({
        id: "call",
        payload: { name: "shell", toolUseId: "t1" },
        type: "tool.call",
      }),
      makeEntry({
        id: "result",
        payload: { output: "x", toolUseId: "t1" },
        type: "tool.result",
      }),
    ]);
    expect(items).toHaveLength(2);
    expect(collectFileIds(items)).toEqual(["file-1"]);
  });
});

describe("toChatItems with output files", () => {
  test("puts each run's output files on its own assistant message only", () => {
    const entries = [
      makeEntry({ id: "u1", payload: { text: "one" }, runId: "run-1" }),
      makeEntry({
        id: "a1",
        payload: { text: "Here [ATTACHMENT:/w/report.md]" },
        runId: "run-1",
        type: "message.assistant",
      }),
      makeEntry({
        id: "u2",
        payload: { text: "two" },
        runId: "run-2",
      }),
      makeEntry({
        id: "a2",
        payload: { text: "done" },
        runId: "run-2",
        type: "message.assistant",
      }),
    ];
    const items = toChatItems(entries, {
      "run-1": ["file-1"],
      "run-2": ["file-2"],
    });
    expect(items).toEqual([
      { fileIds: [], id: "u1", kind: "user", text: "one" },
      { fileIds: ["file-1"], id: "a1", kind: "assistant", text: "Here" },
      { fileIds: [], id: "u2", kind: "user", text: "two" },
      { fileIds: ["file-2"], id: "a2", kind: "assistant", text: "done" },
    ]);
  });

  test("puts a run's output files on its last assistant message", () => {
    const entries = [
      makeEntry({
        id: "a1",
        payload: { text: "first" },
        type: "message.assistant",
      }),
      makeEntry({
        id: "t1",
        payload: { name: "shell" },
        type: "tool.call",
      }),
      makeEntry({
        id: "a2",
        payload: { text: "second" },
        type: "message.assistant",
      }),
    ];
    expect(toChatItems(entries, { "run-1": ["file-1"] })).toEqual([
      { fileIds: [], id: "a1", kind: "assistant", text: "first" },
      {
        detail: JSON.stringify({ name: "shell" }, null, 2),
        id: "t1",
        input: null,
        kind: "tool",
        label: "shell",
        output: null,
      },
      { fileIds: ["file-1"], id: "a2", kind: "assistant", text: "second" },
    ]);
  });

  test("adds an empty assistant item after the last entry of a run with no assistant message", () => {
    const entries = [
      makeEntry({ id: "u1", payload: { text: "make it" }, runId: "run-1" }),
      makeEntry({
        id: "t1",
        payload: { name: "write" },
        runId: "run-1",
        type: "tool.result",
      }),
      makeEntry({ id: "u2", payload: { text: "next" }, runId: "run-2" }),
    ];
    expect(toChatItems(entries, { "run-1": ["file-1"] })).toEqual([
      { fileIds: [], id: "u1", kind: "user", text: "make it" },
      {
        detail: JSON.stringify({ name: "write" }, null, 2),
        id: "t1",
        input: null,
        kind: "tool",
        label: "write",
        output: null,
      },
      {
        fileIds: ["file-1"],
        id: "run-1-files",
        kind: "assistant",
        text: "",
      },
      { fileIds: [], id: "u2", kind: "user", text: "next" },
    ]);
  });

  test("emits nothing for a run in the map that has no entries", () => {
    expect(toChatItems([], { "run-9": ["file-9"] })).toEqual([]);
  });

  test("keeps the default behaviour when no output files are given", () => {
    const entries = [
      makeEntry({ id: "u1", payload: { text: "hi" } }),
      makeEntry({
        id: "a1",
        payload: { fileIds: ["file-1"], text: "Look" },
        type: "message.assistant",
      }),
    ];
    expect(toChatItems(entries)).toEqual([
      { fileIds: [], id: "u1", kind: "user", text: "hi" },
      { fileIds: [], id: "a1", kind: "assistant", text: "Look" },
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
  test("gathers user then assistant file ids, without repeats", () => {
    const items: ChatItem[] = [
      { fileIds: ["file-2", "file-1"], id: "a", kind: "user", text: "" },
      { fileIds: ["file-1", "file-3"], id: "b", kind: "user", text: "" },
      { fileIds: ["file-3", "file-4"], id: "c", kind: "assistant", text: "" },
    ];
    expect(collectFileIds(items)).toEqual([
      "file-2",
      "file-1",
      "file-3",
      "file-4",
    ]);
  });

  test("skips tool items", () => {
    const items: ChatItem[] = [
      {
        detail: "{}",
        id: "t",
        input: null,
        kind: "tool",
        label: "shell",
        output: null,
      },
      { fileIds: ["file-1"], id: "u", kind: "user", text: "" },
    ];
    expect(collectFileIds(items)).toEqual(["file-1"]);
  });

  test("returns [] when nothing is shown", () => {
    expect(collectFileIds([])).toEqual([]);
  });
});

describe("MAX_ATTACHMENTS", () => {
  test("is 20, the server's input file limit", () => {
    expect(MAX_ATTACHMENTS).toBe(20);
  });
});
