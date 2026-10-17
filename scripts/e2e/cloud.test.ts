import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  type CloudDeps,
  CloudError,
  findDuplicateSeqs,
  runCloud,
  seqEventsOf,
} from "./cloud.ts";

const eventsDb = (): Database => {
  const client = new Database(":memory:");
  client.run(
    "CREATE TABLE events (id TEXT PRIMARY KEY, run_id TEXT, seq INTEGER, type TEXT, payload TEXT)"
  );
  return client;
};

const insert = (
  client: Database,
  id: string,
  runId: string,
  seq: number | null,
  text = ""
) => {
  client.run(
    "INSERT INTO events (id, run_id, seq, type, payload) VALUES (?, ?, ?, 'message.assistant', ?)",
    [id, runId, seq, JSON.stringify({ text })]
  );
};

describe("findDuplicateSeqs", () => {
  test("finds a seq written twice for one run and ignores events without a seq", () => {
    const client = eventsDb();
    insert(client, "1", "run-a", 1);
    insert(client, "2", "run-a", 1);
    insert(client, "3", "run-a", 2);
    insert(client, "4", "run-b", 1);
    insert(client, "5", "run-b", null);
    insert(client, "6", "run-b", null);

    expect(findDuplicateSeqs(client, ["run-a", "run-b"])).toEqual([
      { runId: "run-a", seq: 1 },
    ]);
    expect(findDuplicateSeqs(client, ["run-b"])).toEqual([]);
    expect(findDuplicateSeqs(client, [])).toEqual([]);
  });
});

describe("seqEventsOf", () => {
  test("reads a run's events in seq order with their payloads", () => {
    const client = eventsDb();
    insert(client, "1", "run-a", 2, "two");
    insert(client, "2", "run-a", 1, "one");
    insert(client, "3", "run-b", 1, "other");

    expect(
      seqEventsOf(client, "run-a").map((event) => event.payload.text)
    ).toEqual(["one", "two"]);
  });
});

/** A dev server in miniature: every run answers as the faux model would. */
const fakeDeps = (
  options: {
    dupes?: { runId: string; seq: number }[];
    failTool?: boolean;
    staleRead?: boolean;
  } = {}
) => {
  const texts = new Map<string, string>();
  const status = new Map<string, "cancelled" | "done" | "failed">();
  const calls: string[] = [];
  const out: string[] = [];
  let count = 0;
  const resultFor = (text: string): string => {
    if (text.startsWith("call write ")) {
      return "tool said: Successfully wrote to /library/e2e-env/notes.md";
    }
    if (text.startsWith("call edit ")) {
      return "tool said: Successfully edited /library/e2e-env/notes.md";
    }
    if (text.startsWith("call read ")) {
      return `tool said: ${options.staleRead ? "alpha beta" : "gamma beta"}`;
    }
    if (text === "bash cat /library/e2e-env/notes.md") {
      return "tool said: gamma beta";
    }
    if (!text.startsWith("bash ")) {
      return `echo: ${text}`;
    }
    return options.failTool
      ? "no tool"
      : `tool said: ${text.slice("bash ".length)}`;
  };
  const deps: CloudDeps = {
    drive: (action, runId) => {
      calls.push(`${action} ${runId}`);
      const text = texts.get(runId) ?? "";
      if (action === "offer" && !status.has(runId)) {
        if (text === "slow") {
          return Promise.resolve();
        }
        status.set(runId, text.startsWith("fail ") ? "failed" : "done");
      }
      if (action === "cancel") {
        status.set(runId, "cancelled");
      }
      return Promise.resolve();
    },
    duplicateSeqs: () => options.dupes ?? [],
    eventsOf: (runId) => [
      {
        payload: { text: `echo: ${texts.get(runId)}` },
        seq: 1,
        type: "message.assistant",
      },
    ],
    out: (line) => out.push(line),
    send: (text) => {
      count += 1;
      const runId = `run-${count}`;
      texts.set(runId, text);
      return Promise.resolve(runId);
    },
    sleep: () => Promise.resolve(),
    wait: (runId) => {
      const text = texts.get(runId) ?? "";
      const ended = status.get(runId) ?? "done";
      return Promise.resolve({
        error: ended === "failed" ? text.slice("fail ".length) : null,
        resultText: resultFor(text),
        status: ended,
      });
    },
  };
  return { calls, deps, out };
};

describe("runCloud", () => {
  test("passes when every scenario holds, and drives the slow run twice then cancels it", async () => {
    const { calls, deps, out } = fakeDeps();
    await runCloud(deps);
    expect(out.at(-1)).toBe("cloud runtime check passed");
    expect(calls).toEqual([
      "offer run-1",
      "offer run-2",
      "offer run-3",
      "redispatch run-3",
      "cancel run-3",
      "offer run-4",
      "offer run-5",
      "offer run-6",
      "offer run-7",
      "offer run-8",
      "offer run-9",
      "offer run-10",
    ]);
  });

  test("fails on a duplicate seq", async () => {
    const { deps } = fakeDeps({ dupes: [{ runId: "run-1", seq: 1 }] });
    await expect(runCloud(deps)).rejects.toThrow(CloudError);
  });

  test("fails when the tool run does not return the tool's output", async () => {
    const { deps } = fakeDeps({ failTool: true });
    await expect(runCloud(deps)).rejects.toThrow("tool run");
  });

  test("fails when the library read does not return the edited text", async () => {
    const { deps } = fakeDeps({ staleRead: true });
    const error = await runCloud(deps).then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(CloudError);
    expect((error as CloudError).message).toContain("library read");
  });
});
