import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  spyOn,
  test,
} from "bun:test";
import type { EventRecord } from "../events.ts";
import type { Clock } from "../runs/types.ts";
import type { SlackCallResult } from "./client.ts";
import {
  createSlackStatus,
  STATUS_MIN_INTERVAL_MS,
  type StatusClaim,
  type StatusPorts,
  type StatusTarget,
  THINKING_STATUS,
  toolStatus,
} from "./status.ts";

const START_MS = Date.parse("2026-10-16T10:00:00.000Z");
const RUN_ID = "run-1";
const WORKSPACE_ID = "ws-1";
const RETRY_AFTER_SECONDS = 3;
const READ_LABEL = "is reading files…";
const COMMAND_LABEL = "is running a command…";
const GENERIC_LABEL = "is working…";

const target: StatusTarget = {
  agentId: "agent-1",
  channel: "C1",
  teamId: "T1",
  threadTs: "1.1",
  workspaceId: WORKSPACE_ID,
};

const sendOk: SlackCallResult = { kind: "ok" };

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

/** A full event record. Only the fields the status reads vary by test. */
const eventOf = (
  type: EventRecord["type"],
  payload: EventRecord["payload"] = {},
  runId: string | null = RUN_ID
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
  workspaceId: WORKSPACE_ID,
});

const toolCall = (name: string) => eventOf("tool.call", { name });

/**
 * Fake ports that record every call. Each answer can be changed by a test
 * before the call it governs.
 */
const fakePorts = () => {
  const claims: StatusClaim[] = [];
  const finishes: { runId: string; workspaceId: string }[] = [];
  const sends: { status: string; target: StatusTarget }[] = [];
  const answers = {
    claim: (): Promise<StatusTarget | null> => Promise.resolve(target),
    finish: (): Promise<StatusTarget | null> => Promise.resolve(target),
    send: (): Promise<SlackCallResult> => Promise.resolve(sendOk),
  };
  const ports: StatusPorts = {
    claim: (claim) => {
      claims.push(claim);
      return answers.claim();
    },
    finish: (runId, workspaceId) => {
      finishes.push({ runId, workspaceId });
      return answers.finish();
    },
    send: (sent, status) => {
      sends.push({ status, target: sent });
      return answers.send();
    },
  };
  return {
    answers,
    claims,
    finishes,
    ports,
    sends,
    statuses: () => sends.map((send) => send.status),
  };
};

const setUp = (defer?: (work: Promise<void>) => void) => {
  const time = movableClock();
  const fake = fakePorts();
  const status = createSlackStatus({
    clock: time.clock,
    defer,
    ports: fake.ports,
  });
  return { fake, status, time };
};

describe("slack status", () => {
  let warn: Mock<(...data: unknown[]) => void>;

  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe("begin", () => {
    test("claims the thinking label and sends it to the claimed thread", async () => {
      const { fake, status } = setUp();

      await status.begin(RUN_ID, WORKSPACE_ID);

      expect(fake.claims).toEqual([
        {
          cutoff: new Date(START_MS - STATUS_MIN_INTERVAL_MS).toISOString(),
          label: THINKING_STATUS,
          now: new Date(START_MS).toISOString(),
          runId: RUN_ID,
          workspaceId: WORKSPACE_ID,
        },
      ]);
      expect(fake.sends).toEqual([{ status: THINKING_STATUS, target }]);
    });

    test("sends nothing when the claim is lost", async () => {
      const { fake, status } = setUp();
      fake.answers.claim = () => Promise.resolve(null);

      await status.begin(RUN_ID, WORKSPACE_ID);

      expect(fake.claims).toHaveLength(1);
      expect(fake.sends).toEqual([]);
    });
  });

  describe("tool.call", () => {
    test("claims the tool label and sends it when claimed", async () => {
      const { fake, status } = setUp();

      await status.onEvent(toolCall("bash"));

      expect(fake.claims).toHaveLength(1);
      expect(fake.claims[0]).toMatchObject({
        label: COMMAND_LABEL,
        runId: RUN_ID,
        workspaceId: WORKSPACE_ID,
      });
      expect(fake.sends).toEqual([{ status: COMMAND_LABEL, target }]);
    });

    test("sends nothing when the claim is lost", async () => {
      const { fake, status } = setUp();
      fake.answers.claim = () => Promise.resolve(null);

      await status.onEvent(toolCall("bash"));

      expect(fake.sends).toEqual([]);
    });

    test.each([
      ["no name", {}],
      ["a non-string name", { name: 42 }],
    ])("%s gives the generic label", async (_case, payload) => {
      const { fake, status } = setUp();

      await status.onEvent(eventOf("tool.call", payload));

      expect(fake.claims[0]?.label).toBe(GENERIC_LABEL);
      expect(fake.statuses()).toEqual([GENERIC_LABEL]);
    });
  });

  test("run.started claims the thinking label", async () => {
    const { fake, status } = setUp();

    await status.onEvent(eventOf("run.started"));

    expect(fake.claims[0]?.label).toBe(THINKING_STATUS);
    expect(fake.statuses()).toEqual([THINKING_STATUS]);
  });

  describe("ending a run", () => {
    test.each(["run.failed", "run.cancelled", "run.interrupted"] as const)(
      "%s finishes the run and clears the status",
      async (type) => {
        const { fake, status } = setUp();

        await status.onEvent(eventOf(type));

        expect(fake.finishes).toEqual([
          { runId: RUN_ID, workspaceId: WORKSPACE_ID },
        ]);
        expect(fake.sends).toEqual([{ status: "", target }]);
      }
    );

    test.each(["run.failed", "run.cancelled", "run.interrupted"] as const)(
      "%s sends nothing when finish returns null",
      async (type) => {
        const { fake, status } = setUp();
        fake.answers.finish = () => Promise.resolve(null);

        await status.onEvent(eventOf(type));

        expect(fake.finishes).toHaveLength(1);
        expect(fake.sends).toEqual([]);
      }
    );

    test("slack.delivered with delivered false finishes the run and clears the status", async () => {
      const { fake, status } = setUp();

      await status.onEvent(eventOf("slack.delivered", { delivered: false }));

      expect(fake.finishes).toHaveLength(1);
      expect(fake.sends).toEqual([{ status: "", target }]);
    });

    test("slack.delivered with delivered true makes no port call", async () => {
      const { fake, status } = setUp();

      await status.onEvent(eventOf("slack.delivered", { delivered: true }));

      expect(fake.claims).toEqual([]);
      expect(fake.finishes).toEqual([]);
      expect(fake.sends).toEqual([]);
    });
  });

  describe("events that make no port call", () => {
    const silent: [string, EventRecord][] = [
      ["run.finished", eventOf("run.finished")],
      ["message.assistant", eventOf("message.assistant")],
      ["a tool call with no run", eventOf("tool.call", { name: "bash" }, null)],
      ["a failed run with no run", eventOf("run.failed", {}, null)],
    ];

    for (const [name, event] of silent) {
      test(`${name} makes no port call`, async () => {
        const { fake, status } = setUp();

        await status.onEvent(event);

        expect(fake.claims).toEqual([]);
        expect(fake.finishes).toEqual([]);
        expect(fake.sends).toEqual([]);
      });
    }
  });

  describe("send failures", () => {
    test("a missing scope after a claim finishes the run and logs once", async () => {
      const { fake, status } = setUp();
      fake.answers.send = () =>
        Promise.resolve({ error: "missing_scope", kind: "config" });

      await status.onEvent(toolCall("read"));

      expect(fake.finishes).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("missing_scope");
    });

    test("a missing scope logs nothing when another request already stopped the run", async () => {
      const { fake, status } = setUp();
      fake.answers.send = () =>
        Promise.resolve({ error: "missing_scope", kind: "config" });
      fake.answers.finish = () => Promise.resolve(null);

      await status.onEvent(toolCall("read"));

      expect(fake.finishes).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });

    test("a channel type the status does not support finishes the run without a warning", async () => {
      const { fake, status } = setUp();
      fake.answers.send = () =>
        Promise.resolve({
          error: "method_not_supported_for_channel_type",
          kind: "rejected",
        });

      await status.onEvent(toolCall("read"));

      expect(fake.finishes).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });

    test("a rate limit finishes the run and logs ratelimited once", async () => {
      const { fake, status } = setUp();
      fake.answers.send = () =>
        Promise.resolve({
          kind: "rate_limited",
          retryAfterSeconds: RETRY_AFTER_SECONDS,
        });

      await status.onEvent(toolCall("read"));

      expect(fake.finishes).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("ratelimited");
    });

    test("a thrown send finishes the run and logs its message once", async () => {
      const { fake, status } = setUp();
      fake.answers.send = () =>
        Promise.reject(
          new Error("The agent has no installed Slack app for this team")
        );

      await status.onEvent(toolCall("read"));

      expect(fake.finishes).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        "The agent has no installed Slack app for this team"
      );
    });

    test("a failed clear logs once and does not finish the run again", async () => {
      const { fake, status } = setUp();
      fake.answers.send = () =>
        Promise.resolve({ error: "missing_scope", kind: "config" });

      await status.onEvent(eventOf("run.failed"));

      expect(fake.finishes).toHaveLength(1);
      expect(fake.statuses()).toEqual([""]);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    test("a rejected claim logs once, resolves and sends nothing", async () => {
      const { fake, status } = setUp();
      fake.answers.claim = () =>
        Promise.reject(new Error("database is locked"));

      await expect(status.onEvent(toolCall("read"))).resolves.toBeUndefined();

      expect(fake.sends).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("database is locked");
    });
  });

  describe("defer", () => {
    test("begin does not use defer", async () => {
      const deferred: Promise<void>[] = [];
      const { fake, status } = setUp((work) => {
        deferred.push(work);
      });

      await status.begin(RUN_ID, WORKSPACE_ID);

      expect(deferred).toEqual([]);
      expect(fake.statuses()).toEqual([THINKING_STATUS]);
    });

    test("onEvent hands defer the work, which completes the send", async () => {
      const deferred: Promise<void>[] = [];
      const { fake, status, time } = setUp((work) => {
        deferred.push(work);
      });
      await status.begin(RUN_ID, WORKSPACE_ID);
      time.advance(STATUS_MIN_INTERVAL_MS);

      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      fake.answers.send = async () => {
        await gate;
        return sendOk;
      };

      // onEvent returns while Slack has not answered yet.
      await status.onEvent(toolCall("read"));

      expect(deferred).toHaveLength(1);
      let workDone = false;
      const settled = Promise.resolve(deferred[0]).then(() => {
        workDone = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(workDone).toBe(false);

      release();
      await settled;
      expect(workDone).toBe(true);
      expect(fake.statuses()).toEqual([THINKING_STATUS, READ_LABEL]);
    });
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
    expect(toolStatus("mcp__server__Bash")).toBe(COMMAND_LABEL);
  });

  test("an unknown or empty name gives the generic label", () => {
    expect(toolStatus("frobnicate")).toBe(GENERIC_LABEL);
    expect(toolStatus("")).toBe(GENERIC_LABEL);
  });
});
