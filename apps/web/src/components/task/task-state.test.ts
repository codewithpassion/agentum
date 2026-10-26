import { describe, expect, test } from "bun:test";
import type { StreamFrame } from "@repo/protocol/stream";
import { toActionLog } from "@repo/services/tasks/action-log";
import { buildReceipt } from "@repo/services/tasks/receipt";
import type { TaskView } from "#/integrations/trpc/types";
import { receiptRunOf } from "./task-logic.ts";
import {
  applyFrame,
  applyPending,
  applySettled,
  applyTask,
  initialLive,
  lastEventId,
  recordOf,
  requestViews,
  runEvents,
} from "./task-state.ts";

type Event = TaskView["events"][number];

const AT = "2026-10-26T08:00:00.000Z";

const makeEvent = (overrides: Partial<Event>): Event =>
  ({
    actor: { id: "agent-1", kind: "agent" },
    agentId: "agent-1",
    createdAt: AT,
    id: "e01",
    payload: {},
    payloadRef: null,
    runId: "run-1",
    seq: null,
    sessionId: "ses-1",
    type: "message.assistant",
    workspaceId: "ws-1",
    ...overrides,
  }) as Event;

const makeTask = (overrides: {
  events?: Event[];
  request?: TaskView["request"];
  status?: TaskView["run"]["status"];
}): TaskView =>
  ({
    agent: {
      computerMachineId: null,
      id: "agent-1",
      machine: null,
      name: "Bookkeeper",
      runtime: "fake",
    },
    events: overrides.events ?? [],
    eventsTruncated: false,
    otherRuns: [],
    request: overrides.request ?? null,
    run: {
      costUsd: null,
      createdAt: AT,
      finishedAt: null,
      id: "run-1",
      inputText: "Pay the bills",
      startedAt: AT,
      status: overrides.status ?? "running",
    },
    session: { externalKey: null, id: "ses-1", origin: "ui" },
    startedBy: { kind: "person", label: "Dom" },
    title: "Pay the bills",
  }) as TaskView;

const eventFrame = (
  overrides: Partial<Extract<StreamFrame, { frame: "event" }>> & {
    payload?: Record<string, never>;
  }
): StreamFrame =>
  ({
    actor: { id: "agent-1", kind: "agent" },
    createdAt: AT,
    frame: "event",
    id: "e02",
    payload: {},
    runId: "run-1",
    seq: null,
    type: "message.assistant",
    ...overrides,
  }) as StreamFrame;

const OPENED = {
  display: {
    input: { to: "accounts@acme.com" },
    summary: "Email Acme",
    toolKey: "send_mail",
    toolName: "send_mail",
  },
  expiresAt: "2099-01-01T00:00:00.000Z",
  kind: "approval",
  requestId: "req-1",
  toolName: "send_mail",
};

describe("the live state of a task", () => {
  test("it starts from the fetched events and run status", () => {
    const live = initialLive(
      makeTask({ events: [makeEvent({ id: "e01" })], status: "waiting" })
    );
    expect(live.runStatus).toBe("waiting");
    expect(lastEventId(live)).toBe("e01");
  });

  test("an event frame appends once, even when it arrives twice", () => {
    let live = initialLive(makeTask({ events: [makeEvent({ id: "e01" })] }));
    live = applyFrame(live, eventFrame({ id: "e02" }));
    live = applyFrame(live, eventFrame({ id: "e02" }));
    expect(live.events.map(({ id }) => id)).toEqual(["e01", "e02"]);
    expect(lastEventId(live)).toBe("e02");
  });

  test("an event that is older than the newest lands in id order", () => {
    let live = initialLive(makeTask({ events: [makeEvent({ id: "e05" })] }));
    live = applyFrame(live, eventFrame({ id: "e03" }));
    expect(live.events.map(({ id }) => id)).toEqual(["e03", "e05"]);
  });

  test("a truncated frame reads as an empty payload", () => {
    const frame = eventFrame({ id: "e09", truncated: true } as never);
    if (frame.frame !== "event") {
      throw new Error("not an event frame");
    }
    const record = recordOf(frame, "ses-1");
    expect(record.payload).toEqual({});
    expect(record.payloadRef).not.toBeNull();
  });

  test("run frames and run events move only this run's status", () => {
    let live = initialLive(makeTask({ status: "running" }));
    live = applyFrame(live, { frame: "run", runId: "other", status: "failed" });
    expect(live.runStatus).toBe("running");
    live = applyFrame(live, {
      frame: "run",
      runId: "run-1",
      status: "waiting",
    });
    expect(live.runStatus).toBe("waiting");
    live = applyFrame(live, eventFrame({ id: "e03", type: "run.resumed" }));
    expect(live.runStatus).toBe("running");
    live = applyFrame(
      live,
      eventFrame({ id: "e04", runId: "other", type: "run.failed" })
    );
    expect(live.runStatus).toBe("running");
  });

  test("another run's events join the list but not the run's events", () => {
    let live = initialLive(makeTask({}));
    live = applyFrame(live, eventFrame({ id: "e02", runId: "other" }));
    expect(live.events).toHaveLength(1);
    expect(runEvents(live)).toHaveLength(0);
  });

  test("a fresh fetch keeps stream events that are newer than it", () => {
    let live = initialLive(makeTask({ events: [makeEvent({ id: "e01" })] }));
    live = applyFrame(live, eventFrame({ id: "e03" }));
    const next = applyTask(
      live,
      makeTask({ events: [makeEvent({ id: "e01" }), makeEvent({ id: "e02" })] })
    );
    expect(next.events.map(({ id }) => id)).toEqual(["e01", "e02", "e03"]);
  });

  test("a fresh fetch does not undo a status the stream moved on to", () => {
    let live = initialLive(makeTask({ status: "running" }));
    live = applyFrame(live, eventFrame({ id: "e05", type: "run.finished" }));
    const next = applyTask(live, makeTask({ status: "running" }));
    expect(next.runStatus).toBe("done");
  });
});

describe("the requests of a task", () => {
  const opened = (id = "e02") =>
    eventFrame({ id, payload: OPENED as never, type: "request.opened" });

  test("a request.opened event shows as a pending view", () => {
    const live = applyFrame(initialLive(makeTask({})), opened());
    const view = requestViews(live).get("req-1");
    expect(view?.kind).toBe("approval");
    expect(view?.settled).toBeNull();
  });

  test("a request.answered event settles it", () => {
    let live = applyFrame(initialLive(makeTask({})), opened());
    live = applyFrame(
      live,
      eventFrame({
        id: "e03",
        payload: {
          answeredBy: "user-1",
          decision: "allow_once",
          requestId: "req-1",
          via: "slack",
        } as never,
        type: "request.answered",
      })
    );
    expect(requestViews(live).get("req-1")?.settled).toMatchObject({
      answeredBy: "user-1",
      status: "answered",
      via: "slack",
    });
  });

  const sendFailed = (id = "e04") =>
    eventFrame({
      id,
      payload: {
        address: "bob@example.com",
        error: "send_failed",
        messageId: "m-1",
        requestId: "req-1",
        threadId: "t-1",
      } as never,
      type: "mail.failed",
    });

  test("a mail.failed event after an allow adds the send error to the settlement", () => {
    let live = applyFrame(initialLive(makeTask({})), opened());
    live = applyFrame(
      live,
      eventFrame({
        id: "e03",
        payload: {
          answeredBy: "user-1",
          decision: "allow_once",
          requestId: "req-1",
          via: "web",
        } as never,
        type: "request.answered",
      })
    );
    live = applyFrame(live, sendFailed());
    expect(requestViews(live).get("req-1")?.settled).toMatchObject({
      answeredBy: "user-1",
      sendError: "send_failed",
      status: "answered",
    });
  });

  test("a mail.failed event adds the send error to this browser's own answer", () => {
    let live = applyFrame(initialLive(makeTask({})), opened());
    live = applySettled(live, "req-1", {
      answer: { decision: "always_allow" },
      answeredBy: "user-1",
      status: "answered",
      via: "web",
    });
    live = applyFrame(live, sendFailed());
    expect(requestViews(live).get("req-1")?.settled).toMatchObject({
      answer: { decision: "always_allow" },
      sendError: "send_failed",
      status: "answered",
    });
  });

  test("an expired request settles as expired", () => {
    let live = applyFrame(initialLive(makeTask({})), opened());
    live = applyFrame(
      live,
      eventFrame({
        id: "e03",
        payload: { requestId: "req-1" } as never,
        type: "request.expired",
      })
    );
    expect(requestViews(live).get("req-1")?.settled).toEqual({
      status: "expired",
    });
  });

  test("this browser's own answer settles it until an event says more", () => {
    let live = applyFrame(initialLive(makeTask({})), opened());
    live = applySettled(live, "req-1", { status: "conflict" });
    expect(requestViews(live).get("req-1")?.settled).toEqual({
      status: "conflict",
    });
  });

  test("a request of another run is not shown", () => {
    const live = applyFrame(
      initialLive(makeTask({})),
      eventFrame({
        id: "e02",
        payload: OPENED as never,
        runId: "other",
        type: "request.opened",
      })
    );
    expect(requestViews(live).size).toBe(0);
  });

  test("a pending request frame for an unknown request asks for the pending list", () => {
    let live = applyFrame(initialLive(makeTask({})), {
      frame: "request",
      kind: "approval",
      requestId: "req-1",
      runId: "run-1",
      status: "pending",
    });
    expect(live.needsRequests).toBe(true);
    live = applyPending(live, [
      {
        display: OPENED.display,
        expiresAt: OPENED.expiresAt,
        id: "req-1",
        kind: "approval",
        runId: "run-1",
      },
    ]);
    expect(live.needsRequests).toBe(false);
    expect(requestViews(live).has("req-1")).toBe(true);
  });

  test("a request frame for a known request asks for nothing", () => {
    const live = applyFrame(applyFrame(initialLive(makeTask({})), opened()), {
      frame: "request",
      kind: "approval",
      requestId: "req-1",
      runId: "run-1",
      status: "pending",
    });
    expect(live.needsRequests).toBe(false);
  });
});

describe("the receipt and the log follow the stream", () => {
  test("a call, its result, an approval and its answer build the receipt live", () => {
    const task = makeTask({
      events: [
        makeEvent({
          id: "e01",
          payload: { origin: "ui" },
          type: "run.queued",
        }),
      ],
    });
    let live = initialLive(task);
    const steps = () =>
      buildReceipt(receiptRunOf(task, live.runStatus), runEvents(live));
    expect(steps().map(({ title }) => title)).toEqual(["From UI"]);

    live = applyFrame(
      live,
      eventFrame({
        id: "e02",
        payload: {
          input: { to: "a@b.c" },
          name: "xero.create_bill",
          toolUseId: "t1",
        } as never,
        type: "tool.call",
      })
    );
    expect(steps().at(-1)?.state).toBe("running");

    live = applyFrame(
      live,
      eventFrame({
        id: "e03",
        payload: { ok: true, output: "{}", toolUseId: "t1" } as never,
        type: "tool.result",
      })
    );
    expect(steps().at(-1)?.state).toBe("done");

    live = applyFrame(
      live,
      eventFrame({
        id: "e04",
        payload: OPENED as never,
        type: "request.opened",
      })
    );
    live = applyFrame(live, {
      frame: "run",
      runId: "run-1",
      status: "waiting",
    });
    const paused = steps().at(-1);
    expect(paused?.state).toBe("paused");
    expect(paused?.requestId).toBe("req-1");

    live = applyFrame(
      live,
      eventFrame({
        id: "e05",
        payload: { decision: "allow_once", requestId: "req-1" } as never,
        type: "request.answered",
      })
    );
    live = applyFrame(live, eventFrame({ id: "e06", type: "run.resumed" }));
    expect(steps().at(-1)?.state).toBe("done");
    expect(live.runStatus).toBe("running");
    expect(toActionLog(runEvents(live)).map(({ kind }) => kind)).toEqual([
      "tool_call",
      "tool_result",
      "note",
      "note",
    ]);
  });
});
