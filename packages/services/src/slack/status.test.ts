import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { EventRecord } from "../events.ts";
import type { Clock } from "../runs/types.ts";
import type { SlackCallResult } from "./client.ts";
import {
  createSlackStatus,
  type StatusPorts,
  type StatusTarget,
  THINKING_STATUS,
  toolStatus,
} from "./status.ts";

const START_MS = Date.parse("2026-10-16T10:00:00.000Z");
const WAIT_MS = 5000;

const target: StatusTarget = {
  agentId: "agent-1",
  channel: "C1",
  teamId: "T1",
  threadTs: "1.1",
  workspaceId: "ws-1",
};

/** A clock that only moves when the test says so. */
const movableClock = () => {
  let nowMs = START_MS;
  const clock: Clock = {
    now: () => new Date(nowMs),
    sleep: () => Promise.resolve(),
  };
  return {
    advance: (ms: number) => {
      nowMs += ms;
    },
    clock,
  };
};

/** An event of a run, with the fields the status reads. */
const eventOf = (
  type: EventRecord["type"],
  payload: EventRecord["payload"] = {},
  runId: string | null = "run-1"
): EventRecord => ({
  actor: { id: "agent-1", kind: "system" },
  agentId: "agent-1",
  createdAt: new Date(START_MS).toISOString(),
  id: `evt-${type}`,
  payload,
  payloadRef: null,
  runId,
  seq: null,
  sessionId: "session-1",
  type,
  workspaceId: "ws-1",
});

const toolCall = (name: string) => eventOf("tool.call", { name });

/** Fake ports. `respond` answers each send. `targetOf` answers from `targetFor`. */
const fakePorts = () => {
  const sends: Array<{ status: string; target: StatusTarget }> = [];
  const lookups: string[] = [];
  const ports = {
    respond: (_status: string): SlackCallResult => ({ kind: "ok" }),
    targetFor: (_runId: string): StatusTarget | null => target,
  };
  const statusPorts: StatusPorts = {
    send: (sent, status) => {
      sends.push({ status, target: sent });
      return Promise.resolve(ports.respond(status));
    },
    targetOf: (event) => {
      lookups.push(event.runId ?? "");
      return Promise.resolve(ports.targetFor(event.runId ?? ""));
    },
  };
  return {
    lookups,
    ports,
    sends,
    statuses: () => sends.map((send) => send.status),
    statusPorts,
  };
};

describe("slack status", () => {
  let warn: ReturnType<typeof spyOn<Console, "warn">>;

  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  test("begin sends the thinking status", async () => {
    const { clock } = movableClock();
    const fake = fakePorts();
    const status = createSlackStatus({ clock, ports: fake.statusPorts });

    await status.begin("run-1", target);

    expect(fake.sends).toEqual([{ status: THINKING_STATUS, target }]);
  });

  test("a tool call after 5 s sends the tool label", async () => {
    const time = movableClock();
    const fake = fakePorts();
    const status = createSlackStatus({
      clock: time.clock,
      ports: fake.statusPorts,
    });
    await status.begin("run-1", target);

    time.advance(WAIT_MS);
    await status.onEvent(toolCall("read"));

    expect(fake.statuses()).toEqual([THINKING_STATUS, "is reading files…"]);
  });

  test("a second tool call under 5 s later sends nothing", async () => {
    const time = movableClock();
    const fake = fakePorts();
    const status = createSlackStatus({
      clock: time.clock,
      ports: fake.statusPorts,
    });
    await status.begin("run-1", target);
    time.advance(WAIT_MS);
    await status.onEvent(toolCall("bash"));

    time.advance(WAIT_MS - 1);
    await status.onEvent(toolCall("read"));

    expect(fake.statuses()).toEqual([THINKING_STATUS, "is running a command…"]);
  });

  test("a tool call another 5 s later sends again", async () => {
    const time = movableClock();
    const fake = fakePorts();
    const status = createSlackStatus({
      clock: time.clock,
      ports: fake.statusPorts,
    });
    await status.begin("run-1", target);
    time.advance(WAIT_MS);
    await status.onEvent(toolCall("bash"));
    time.advance(WAIT_MS - 1);
    await status.onEvent(toolCall("read"));

    time.advance(1);
    await status.onEvent(toolCall("read"));

    expect(fake.statuses()).toEqual([
      THINKING_STATUS,
      "is running a command…",
      "is reading files…",
    ]);
  });

  test("the same label twice sends once", async () => {
    const time = movableClock();
    const fake = fakePorts();
    const status = createSlackStatus({
      clock: time.clock,
      ports: fake.statusPorts,
    });
    await status.begin("run-1", target);
    time.advance(WAIT_MS);
    await status.onEvent(toolCall("read"));
    time.advance(WAIT_MS);

    await status.onEvent(toolCall("read"));

    expect(fake.statuses()).toEqual([THINKING_STATUS, "is reading files…"]);
  });

  test.each(["run.failed", "run.cancelled", "run.interrupted"] as const)(
    "%s clears the status",
    async (type) => {
      const { clock } = movableClock();
      const fake = fakePorts();
      const status = createSlackStatus({ clock, ports: fake.statusPorts });
      await status.begin("run-1", target);

      await status.onEvent(eventOf(type));

      expect(fake.statuses()).toEqual([THINKING_STATUS, ""]);
    }
  );

  test("a missing scope logs one warning, stops the run and does not throw", async () => {
    const time = movableClock();
    const fake = fakePorts();
    fake.ports.respond = () => ({ error: "missing_scope", kind: "config" });
    const status = createSlackStatus({
      clock: time.clock,
      ports: fake.statusPorts,
    });

    await status.begin("run-1", target);
    time.advance(WAIT_MS);
    await status.onEvent(toolCall("read"));
    await status.onEvent(eventOf("run.failed"));

    expect(fake.sends).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("missing_scope");
  });

  test("method_not_supported_for_channel_type stops the run without a warning", async () => {
    const time = movableClock();
    const fake = fakePorts();
    fake.ports.respond = () => ({
      error: "method_not_supported_for_channel_type",
      kind: "rejected",
    });
    const status = createSlackStatus({
      clock: time.clock,
      ports: fake.statusPorts,
    });

    await status.begin("run-1", target);
    time.advance(WAIT_MS);
    await status.onEvent(toolCall("read"));

    expect(fake.sends).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a thrown send logs one warning and stops the run", async () => {
    const time = movableClock();
    const fake = fakePorts();
    fake.ports.respond = () => {
      throw new Error("The agent has no installed Slack app for this team");
    };
    const status = createSlackStatus({
      clock: time.clock,
      ports: fake.statusPorts,
    });

    await status.begin("run-1", target);
    time.advance(WAIT_MS);
    await status.onEvent(toolCall("read"));

    expect(fake.sends).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "The agent has no installed Slack app for this team"
    );
  });

  test("a run that does not reply in Slack makes no send and is looked up once", async () => {
    const time = movableClock();
    const fake = fakePorts();
    fake.ports.targetFor = () => null;
    const status = createSlackStatus({
      clock: time.clock,
      ports: fake.statusPorts,
    });

    await status.onEvent(toolCall("read"));
    await status.onEvent(eventOf("run.started"));
    await status.onEvent(eventOf("run.failed"));

    expect(fake.sends).toHaveLength(0);
    expect(fake.lookups).toEqual(["run-1"]);
  });

  test("slack.delivered with delivered false clears the status", async () => {
    const { clock } = movableClock();
    const fake = fakePorts();
    const status = createSlackStatus({ clock, ports: fake.statusPorts });
    await status.begin("run-1", target);

    await status.onEvent(eventOf("slack.delivered", { delivered: false }));

    expect(fake.statuses()).toEqual([THINKING_STATUS, ""]);
  });

  test("slack.delivered with delivered true sends nothing", async () => {
    const { clock } = movableClock();
    const fake = fakePorts();
    const status = createSlackStatus({ clock, ports: fake.statusPorts });
    await status.begin("run-1", target);

    await status.onEvent(eventOf("slack.delivered", { delivered: true }));

    expect(fake.statuses()).toEqual([THINKING_STATUS]);
  });

  test("no send after the run finished", async () => {
    const time = movableClock();
    const fake = fakePorts();
    const status = createSlackStatus({
      clock: time.clock,
      ports: fake.statusPorts,
    });
    await status.begin("run-1", target);

    await status.onEvent(eventOf("run.finished"));
    time.advance(WAIT_MS);
    await status.onEvent(toolCall("read"));

    expect(fake.statuses()).toEqual([THINKING_STATUS]);
  });

  test("the 501st run evicts the first", async () => {
    const time = movableClock();
    const fake = fakePorts();
    const status = createSlackStatus({
      clock: time.clock,
      ports: fake.statusPorts,
    });
    // Each begin stores its state before it awaits the send, so all 501 are stored.
    await Promise.all(
      Array.from({ length: 501 }, (_, i) => status.begin(`run-${i}`, target))
    );
    time.advance(WAIT_MS);

    await status.onEvent(eventOf("tool.call", { name: "read" }, "run-500"));
    await status.onEvent(eventOf("tool.call", { name: "read" }, "run-0"));

    expect(fake.lookups).toEqual(["run-0"]);
  });

  test("defer receives the work, and the send happens when it is awaited", async () => {
    const time = movableClock();
    const fake = fakePorts();
    const deferred: Promise<void>[] = [];
    const status = createSlackStatus({
      clock: time.clock,
      defer: (work) => {
        deferred.push(work);
      },
      ports: fake.statusPorts,
    });
    await status.begin("run-1", target);
    time.advance(WAIT_MS);

    await status.onEvent(toolCall("read"));

    expect(deferred).toHaveLength(1);
    expect(fake.statuses()).toEqual([THINKING_STATUS, "is reading files…"]);
    await deferred[0];
    expect(fake.statuses()).toEqual([THINKING_STATUS, "is reading files…"]);
  });

  test("a tool call without a name shows the generic label", async () => {
    const time = movableClock();
    const fake = fakePorts();
    const status = createSlackStatus({
      clock: time.clock,
      ports: fake.statusPorts,
    });
    await status.begin("run-1", target);
    time.advance(WAIT_MS);

    await status.onEvent(eventOf("tool.call", {}));

    expect(fake.statuses()).toEqual([THINKING_STATUS, "is working…"]);
  });
});

describe("toolStatus", () => {
  test.each([
    ["read", "is reading files…"],
    ["glob", "is reading files…"],
    ["grep", "is reading files…"],
    ["ls", "is reading files…"],
    ["find", "is reading files…"],
    ["write", "is editing files…"],
    ["edit", "is editing files…"],
    ["multiedit", "is editing files…"],
    ["notebookedit", "is editing files…"],
    ["apply_patch", "is editing files…"],
    ["bash", "is running a command…"],
    ["run_skill_script", "is running a command…"],
    ["websearch", "is searching the web…"],
    ["web_search", "is searching the web…"],
    ["webfetch", "is searching the web…"],
    ["web_fetch", "is searching the web…"],
  ])("%s gives its group label", (name, label) => {
    expect(toolStatus(name)).toBe(label);
  });

  test("a prefixed MCP name uses the part after the last double underscore", () => {
    expect(toolStatus("mcp__harbourmaster__slack_search")).toBe(
      "is searching Slack…"
    );
    expect(toolStatus("mcp__server__Bash")).toBe("is running a command…");
  });

  test("an unknown or empty name gives the generic label", () => {
    expect(toolStatus("frobnicate")).toBe("is working…");
    expect(toolStatus("")).toBe("is working…");
  });
});
