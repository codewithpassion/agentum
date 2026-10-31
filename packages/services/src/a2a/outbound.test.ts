import { beforeEach, describe, expect, test } from "bun:test";
import { HOPS_METADATA_KEY } from "@repo/a2a/extensions";
import { a2aOutboundTasks } from "@repo/db/schema/a2a";
import { events as eventRows } from "@repo/db/schema/events";
import { runRequests } from "@repo/db/schema/requests";
import { runs as runRows } from "@repo/db/schema/runs";
import { speakerEnvelopeSchema } from "@repo/protocol/live";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { hashToken } from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import { A2aRateLimitError } from "./errors.ts";
import {
  BASE_URL,
  createOutboundFixture,
  OUTBOUND_CONNECTION,
  type OutboundFixture,
  peerCard,
} from "./outbound-fixture.ts";
import { AGENT, member } from "./tasks-fixture.ts";

let f: OutboundFixture;

beforeEach(async () => {
  f = await createOutboundFixture();
});

const rejects = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to be refused");
};

const rowOf = async (id: string) => {
  const [row] = await f.db
    .select()
    .from(a2aOutboundTasks)
    .where(eq(a2aOutboundTasks.id, id));
  if (!row) {
    throw new Error(`No outbound task ${id}`);
  }
  return row;
};

const eventTypes = async () =>
  (await f.db.select({ type: eventRows.type }).from(eventRows)).map(
    (row) => row.type
  );

const methods = () => f.peer.calls.map((call) => call.method);

const sendFrom = async (
  call: Awaited<ReturnType<typeof f.callingRun>>,
  requestId = "req-1",
  text = "What is the weather?"
) =>
  await f.outbound.send(call.principal, {
    connection: OUTBOUND_CONNECTION,
    requestId,
    text,
  });

const advanceMinutes = (minutes: number) => f.advance(minutes * 60_000);

describe("outbound policy", () => {
  test("off refuses the message and sends nothing", async () => {
    await f.connectPeer({ outboundPolicy: "off" });
    const call = await f.callingRun();

    const error = await rejects(sendFrom(call));

    expect(error).toBeInstanceOf(ServiceError);
    expect(f.peer.calls).toEqual([]);
    expect(await eventTypes()).toContain("a2a.message_refused");
    expect(await f.db.select().from(a2aOutboundTasks)).toEqual([]);
  });

  test("auto sends at once, with our own context and the hop count", async () => {
    await f.connectPeer();
    const call = await f.callingRun();

    const info = await sendFrom(call);

    expect(info.status).toBe("running");
    const send = f.peer.calls.at(0);
    expect(send?.method).toBe("SendMessage");
    const message = send?.params.message as {
      contextId: string;
      metadata: Record<string, number>;
      parts: { text: string }[];
    };
    expect(message.contextId).toStartWith("hm-aot_");
    expect(message.parts[0]?.text).toBe("What is the weather?");
    expect(message.metadata[HOPS_METADATA_KEY]).toBe(1);
    expect(send?.authorization).toBe("Bearer peer-secret");
    const row = await rowOf(info.runId);
    expect(row.remoteTaskId).toBe("rt-1");
    expect(row.sessionId).toBe(call.sessionId);
    expect(await eventTypes()).toContain("a2a.message_sent");
  });

  test("approve opens a card with the peer and the full text and sends nothing before the answer", async () => {
    await f.connectPeer({ outboundPolicy: "approve" });
    const call = await f.callingRun();
    const text = `Please look at this. ${"x".repeat(3000)}`;

    const info = await sendFrom(call, "req-1", text);

    expect(info.status).toBe("waiting");
    expect(f.peer.calls).toEqual([]);
    const [request] = await f.db.select().from(runRequests);
    expect(request?.toolName).toBe("a2a_send");
    expect(request?.toolUseId).toBe(`a2a:${info.runId}`);
    const display = JSON.parse(request?.display ?? "{}") as {
      input: { host: string; peer: string; text: string };
    };
    expect(display.input.peer).toBe("Fake Peer");
    expect(display.input.host).toBe("peer.test");
    expect(display.input.text).toBe(text);
    // The calling run does not wait on this card.
    const [run] = await f.db
      .select()
      .from(runRows)
      .where(eq(runRows.id, call.runId));
    expect(run?.status).toBe("running");
  });

  test("approve sends after a person allows it", async () => {
    await f.connectPeer({ outboundPolicy: "approve" });
    const call = await f.callingRun();
    const info = await sendFrom(call);
    const [request] = await f.db.select().from(runRequests);

    await f.requests.answer(member(), {
      answer: { decision: "allow_once" },
      requestId: request?.id ?? "",
      via: "web",
    });

    expect(methods()).toContain("SendMessage");
    const row = await rowOf(info.runId);
    expect(row.remoteTaskId).toBe("rt-1");
    expect(row.state).toBe("TASK_STATE_WORKING");
    expect(await eventTypes()).toContain("a2a.message_approved");
  });

  test("approve sends nothing when a person denies it", async () => {
    await f.connectPeer({ outboundPolicy: "approve" });
    const call = await f.callingRun();
    const info = await sendFrom(call);
    const [request] = await f.db.select().from(runRequests);

    await f.requests.answer(member(), {
      answer: { decision: "deny" },
      requestId: request?.id ?? "",
      via: "web",
    });

    expect(f.peer.calls).toEqual([]);
    const row = await rowOf(info.runId);
    expect(row.state).toBe("TASK_STATE_REJECTED");
    expect(row.resultText).toBe("A person declined to send this message.");
    expect(await eventTypes()).toContain("a2a.message_declined");
  });

  test("approve refuses a message too long to show a person in full", async () => {
    await f.connectPeer({ outboundPolicy: "approve" });
    const call = await f.callingRun();

    const error = await rejects(sendFrom(call, "req-1", "y".repeat(9000)));

    expect(error).toBeInstanceOf(ServiceError);
    expect(f.peer.calls).toEqual([]);
  });

  test("a revoke while the card waits means an approval afterwards sends nothing", async () => {
    await f.connectPeer({ outboundPolicy: "approve" });
    const call = await f.callingRun();
    const info = await sendFrom(call);
    const [request] = await f.db.select().from(runRequests);
    await f.connections.revoke(member(), OUTBOUND_CONNECTION);

    await f.requests.answer(member(), {
      answer: { decision: "allow_once" },
      requestId: request?.id ?? "",
      via: "web",
    });

    expect(f.peer.calls).toEqual([]);
    expect((await rowOf(info.runId)).state).toBe("TASK_STATE_FAILED");
  });
});

describe("sending", () => {
  test("a retry with the same requestId sends once", async () => {
    await f.connectPeer();
    const call = await f.callingRun();

    const first = await sendFrom(call);
    const second = await sendFrom(call);

    expect(second.runId).toBe(first.runId);
    expect(methods().filter((method) => method === "SendMessage")).toHaveLength(
      1
    );
    expect(await f.db.select().from(a2aOutboundTasks)).toHaveLength(1);
  });

  test("two sends at once with the same requestId send once", async () => {
    await f.connectPeer();
    const call = await f.callingRun();

    const [a, b] = await Promise.all([
      f.newOutbound().send(call.principal, {
        connection: OUTBOUND_CONNECTION,
        requestId: "same",
        text: "Hello",
      }),
      f.newOutbound().send(call.principal, {
        connection: OUTBOUND_CONNECTION,
        requestId: "same",
        text: "Hello",
      }),
    ]);

    expect(a.runId).toBe(b.runId);
    expect(methods().filter((method) => method === "SendMessage")).toHaveLength(
      1
    );
  });

  test("a different requestId is a new task", async () => {
    await f.connectPeer();
    const call = await f.callingRun();

    const first = await sendFrom(call, "req-1");
    const second = await sendFrom(call, "req-2");

    expect(second.runId).not.toBe(first.runId);
  });

  test("the hourly limit refuses the next task and records it", async () => {
    await f.connectPeer({ hourlyLimit: 1 });
    const call = await f.callingRun();
    await sendFrom(call, "req-1");

    const error = await rejects(sendFrom(call, "req-2"));

    expect(error).toBeInstanceOf(A2aRateLimitError);
    expect(methods().filter((method) => method === "SendMessage")).toHaveLength(
      1
    );
    expect(await eventTypes()).toContain("a2a.rate_limited");
  });

  test("a run already as deep as the cap passes no message on", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    await f.db
      .update(runRows)
      .set({ depth: 3 })
      .where(eq(runRows.id, call.runId));

    const error = await rejects(sendFrom(call));

    expect(error).toBeInstanceOf(ServiceError);
    expect(f.peer.calls).toEqual([]);
  });

  test("the hop count is the calling run's depth plus one", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    await f.db
      .update(runRows)
      .set({ depth: 2 })
      .where(eq(runRows.id, call.runId));

    await sendFrom(call);

    const message = f.peer.calls.at(0)?.params.message as {
      metadata: Record<string, number>;
    };
    expect(message.metadata[HOPS_METADATA_KEY]).toBe(3);
  });

  test("a peer that calls us has no address, so there is nothing to send to", async () => {
    await f.connectPeer({ peerKind: "a2a_inbound" });
    const call = await f.callingRun();

    expect(await rejects(sendFrom(call))).toBeInstanceOf(ServiceError);
    expect(f.peer.calls).toEqual([]);
  });

  test("a card that moved to another origin gets no message and no credential", async () => {
    await f.connectPeer({
      peerCard: JSON.stringify({
        ...peerCard(),
        supportedInterfaces: [
          {
            protocolBinding: "JSONRPC",
            protocolVersion: "1.0",
            url: "https://elsewhere.test/rpc",
          },
        ],
      }),
    });
    const call = await f.callingRun();

    expect(await rejects(sendFrom(call))).toBeInstanceOf(ServiceError);
    expect(f.peer.calls).toEqual([]);
  });

  test("a connection that is not active is refused", async () => {
    await f.connectPeer({ status: "needs_approval" });
    const call = await f.callingRun();

    expect(await rejects(sendFrom(call))).toBeInstanceOf(ServiceError);
    expect(f.peer.calls).toEqual([]);
  });

  test("another agent's run, a person and a dry run cannot send", async () => {
    await f.connectPeer();
    await f.seedAgent("a-other");
    const call = await f.callingRun();
    const input = {
      connection: OUTBOUND_CONNECTION,
      requestId: "r",
      text: "Hello",
    };

    expect(
      await rejects(
        f.outbound.send({ ...call.principal, agentId: "a-other" }, input)
      )
    ).toBeInstanceOf(ServiceError);
    expect(await rejects(f.outbound.send(member(), input))).toBeInstanceOf(
      ForbiddenError
    );
    expect(
      await rejects(
        f.outbound.send({ ...call.principal, dryRun: true } as never, input)
      )
    ).toBeInstanceOf(ServiceError);
    expect(f.peer.calls).toEqual([]);
  });

  test("a peer that answers with a plain message completes the task", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    f.peer.sendMessage = "message";

    const info = await sendFrom(call);

    expect(info.status).toBe("done");
    expect(info.answer).toBe("Hello back");
  });

  test("a peer error fails the task with words of ours, not the peer's", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    f.peer.sendMessage = "error";

    const info = await sendFrom(call);

    expect(info.status).toBe("failed");
    expect(info.error).toContain("The peer refused the message");
  });

  test("the bearer token never leaves for a peer whose card needs none", async () => {
    await f.connectPeer({ credential: null, outboundScheme: "none" });
    const call = await f.callingRun();

    await sendFrom(call);

    expect(f.peer.calls.at(0)?.authorization).toBeNull();
  });

  test("an API key goes in its own header", async () => {
    await f.connectPeer({
      credential: "key-123",
      outboundScheme: "api_key_header:X-Api-Key",
    });
    const call = await f.callingRun();

    await sendFrom(call);

    expect(f.peer.calls.at(0)?.headers["x-api-key"]).toBe("key-123");
    expect(f.peer.calls.at(0)?.authorization).toBeNull();
  });
});

describe("push and the webhook", () => {
  const webhookToken = (taskId: string) => {
    const call = f.peer.calls.find(
      (entry) => entry.method === "CreateTaskPushNotificationConfig"
    );
    const url = String(call?.params.url ?? "");
    const [, token] = url.split(`/a2a/webhooks/${taskId}/`);
    return { token: token ?? "", url };
  };

  test("a per-task webhook is registered when the card supports push", async () => {
    await f.connectPeer();
    const call = await f.callingRun();

    const info = await sendFrom(call);

    const { token, url } = webhookToken(info.runId);
    expect(url).toStartWith(`${BASE_URL}/a2a/webhooks/${info.runId}/`);
    expect((await rowOf(info.runId)).webhookTokenHash).toBe(
      await hashToken(token)
    );
    expect(token.length).toBeGreaterThan(20);
  });

  test("no webhook is registered when the card says no push", async () => {
    await f.connectPeer({ peerCard: JSON.stringify(peerCard(false)) });
    const call = await f.callingRun();

    await sendFrom(call);

    expect(methods()).not.toContain("CreateTaskPushNotificationConfig");
  });

  test("a peer that refuses the webhook is still polled", async () => {
    await f.connectPeer();
    f.peer.refusePush = true;
    const call = await f.callingRun();

    const info = await sendFrom(call);

    expect(info.status).toBe("running");
    expect((await rowOf(info.runId)).nextPollAt).not.toBeNull();
  });

  test("a push with the wrong token changes nothing and asks the peer nothing", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    const info = await sendFrom(call);
    f.peer.finish("rt-1", "Sunny");
    const before = f.peer.calls.length;

    const nudged = await f.outbound.nudge(info.runId, "not-the-token");

    expect(nudged.ok).toBe(false);
    expect(f.peer.calls).toHaveLength(before);
    expect((await rowOf(info.runId)).state).toBe("TASK_STATE_WORKING");
  });

  test("a push for a task that does not exist answers as a wrong token does", async () => {
    expect((await f.outbound.nudge("aot_nope", "x")).ok).toBe(false);
  });

  test("a push only moves the task when GetTask agrees", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    const info = await sendFrom(call);
    const { token } = webhookToken(info.runId);

    // The peer says it is still working, whatever a push body claims.
    const nudged = await f.outbound.nudge(info.runId, token);
    expect(nudged.ok).toBe(true);
    expect((await rowOf(info.runId)).state).toBe("TASK_STATE_WORKING");
    expect(methods()).toContain("GetTask");

    f.peer.finish("rt-1", "Sunny");
    await f.outbound.nudge(info.runId, token);
    const row = await rowOf(info.runId);
    expect(row.state).toBe("TASK_STATE_COMPLETED");
    expect(row.resultText).toBe("Sunny");
  });

  test("a duplicate push changes nothing more", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    const info = await sendFrom(call);
    const { token } = webhookToken(info.runId);
    f.peer.finish("rt-1", "Sunny");

    await f.outbound.nudge(info.runId, token);
    const first = await rowOf(info.runId);
    await f.outbound.nudge(info.runId, token);
    const second = await rowOf(info.runId);

    expect(second).toEqual(first);
    const received = (await eventTypes()).filter(
      (type) => type === "a2a.result_received"
    );
    expect(received).toHaveLength(1);
  });

  test("a push for a revoked connection is refused", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    const info = await sendFrom(call);
    const { token } = webhookToken(info.runId);
    await f.connections.revoke(member(), OUTBOUND_CONNECTION);
    const before = f.peer.calls.length;

    const nudged = await f.outbound.nudge(info.runId, token);

    expect(nudged.ok).toBe(false);
    expect(f.peer.calls).toHaveLength(before);
  });
});

describe("polling", () => {
  test("a timed-out send finds the task through ListTasks and goes on polling", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    f.peer.sendMessage = "timeout";

    const info = await sendFrom(call);

    expect(info.status).toBe("queued");
    expect((await rowOf(info.runId)).remoteTaskId).toBeNull();

    f.peer.finish("rt-1", "Late answer");
    advanceMinutes(2);
    await f.outbound.pollDue(f.system);

    const row = await rowOf(info.runId);
    expect(methods()).toContain("ListTasks");
    expect(row.remoteTaskId).toBe("rt-1");
    expect(row.state).toBe("TASK_STATE_COMPLETED");
    expect(row.resultText).toBe("Late answer");
  });

  test("a message the peer never shows is given up on after ten minutes", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    f.peer.sendMessage = "timeout";
    const info = await sendFrom(call);
    f.peer.tasks.clear();

    advanceMinutes(2);
    await f.outbound.pollDue(f.system);
    expect((await rowOf(info.runId)).state).toBe("TASK_STATE_SUBMITTED");

    advanceMinutes(10);
    await f.outbound.pollDue(f.system);
    const row = await rowOf(info.runId);
    expect(row.state).toBe("TASK_STATE_FAILED");
    expect(row.nextPollAt).toBeNull();
  });

  test("polling runs to completion and then stops", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    const info = await sendFrom(call);

    advanceMinutes(2);
    await f.outbound.pollDue(f.system);
    expect((await rowOf(info.runId)).state).toBe("TASK_STATE_WORKING");

    f.peer.finish("rt-1", "Done");
    advanceMinutes(2);
    await f.outbound.pollDue(f.system);
    const row = await rowOf(info.runId);
    expect(row.state).toBe("TASK_STATE_COMPLETED");
    expect(row.nextPollAt).toBeNull();

    const calls = f.peer.calls.length;
    advanceMinutes(10);
    await f.outbound.pollDue(f.system);
    expect(f.peer.calls).toHaveLength(calls);
  });

  test("polling stops at 24 hours and fails the task locally", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    const info = await sendFrom(call);

    advanceMinutes(24 * 60 + 5);
    await f.outbound.pollDue(f.system);

    const row = await rowOf(info.runId);
    expect(row.state).toBe("TASK_STATE_FAILED");
    expect(row.resultText).toContain("24 hours");
    expect(row.nextPollAt).toBeNull();
    const calls = f.peer.calls.length;
    advanceMinutes(10);
    await f.outbound.pollDue(f.system);
    expect(f.peer.calls).toHaveLength(calls);
  });

  test("a peer that forgot the task ends it", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    const info = await sendFrom(call);
    f.peer.tasks.clear();

    advanceMinutes(2);
    await f.outbound.pollDue(f.system);

    expect((await rowOf(info.runId)).state).toBe("TASK_STATE_FAILED");
  });

  test("a peer that is down keeps the task for the next poll", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    const info = await sendFrom(call);
    const working = f.peer.fetch;
    f.peer.fetch = () => Promise.reject(new TypeError("fetch failed"));
    // The service holds the fetch it was built with, so build a failing one.
    const down = f.newOutbound();
    advanceMinutes(2);
    await down.pollDue(f.system);
    f.peer.fetch = working;

    expect((await rowOf(info.runId)).state).toBe("TASK_STATE_WORKING");
  });

  test("get reads the answer in the RunInfo shape and asks the peer again", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    const info = await sendFrom(call);
    f.peer.finish("rt-1", "Sunny");
    advanceMinutes(1);

    const read = await f.outbound.get(call.principal, info.runId);

    expect(read).toMatchObject({
      agentId: AGENT,
      answer: "Sunny",
      error: null,
      runId: info.runId,
      sessionId: call.sessionId,
      status: "done",
    });
  });

  test("another agent's run cannot read the task", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    const info = await sendFrom(call);

    const error = await rejects(
      f.outbound.get({ ...call.principal, agentId: "a-other" }, info.runId)
    );

    expect(error).toBeInstanceOf(ForbiddenError);
  });
});

describe("wakes", () => {
  const replyTarget = {
    channel: "C1",
    kind: "slack",
    teamId: "T1",
    threadTs: "1700.1",
  } as const;

  const wakeRuns = async (sessionId: string) =>
    (await f.db.select().from(runRows)).filter(
      (run) =>
        run.sessionId === sessionId && run.requestId?.startsWith("a2a-wake:")
    );

  test("a result after the calling run ended starts a run in the same session with the same reply target", async () => {
    await f.connectPeer();
    const call = await f.callingRun({ reply: replyTarget });
    const info = await sendFrom(call);
    await f.runs.completeRun(f.system, call.runId, {
      status: "done",
      text: "I asked.",
    });
    f.peer.finish("rt-1", "Sunny and 21 degrees");
    advanceMinutes(2);

    await f.outbound.pollDue(f.system);

    const [wake] = await wakeRuns(call.sessionId);
    expect(wake).toBeDefined();
    expect(wake?.sessionId).toBe(call.sessionId);
    expect(JSON.parse(String(wake?.reply))).toEqual(replyTarget);
    const envelope = speakerEnvelopeSchema.parse(
      JSON.parse(wake?.inputText ?? "{}")
    );
    expect(envelope.harbourmaster_turn.from.kind).toBe("peer");
    expect(envelope.harbourmaster_turn.text).toContain("Sunny and 21 degrees");
    expect((await rowOf(info.runId)).resultReadAt).not.toBeNull();
  });

  test("the wake happens once", async () => {
    await f.connectPeer();
    const call = await f.callingRun({ reply: replyTarget });
    await sendFrom(call);
    await f.runs.completeRun(f.system, call.runId, { status: "done" });
    f.peer.finish("rt-1", "Sunny");
    advanceMinutes(2);
    await f.outbound.pollDue(f.system);

    await f.outbound.wakeDue(f.system);
    await f.outbound.wakeDue(f.system);
    await Promise.all([
      f.newOutbound().wakeDue(f.system),
      f.newOutbound().wakeDue(f.system),
    ]);

    expect(await wakeRuns(call.sessionId)).toHaveLength(1);
  });

  test("the tick wakes an unread result on a run that ended after the result arrived", async () => {
    await f.connectPeer();
    const call = await f.callingRun({ reply: replyTarget });
    await sendFrom(call);
    f.peer.finish("rt-1", "Sunny");
    advanceMinutes(2);
    await f.outbound.pollDue(f.system);
    // The calling run is still alive, so nothing wakes yet.
    expect(await wakeRuns(call.sessionId)).toHaveLength(0);

    await f.runs.completeRun(f.system, call.runId, { status: "done" });
    await f.outbound.wakeDue(f.system);

    expect(await wakeRuns(call.sessionId)).toHaveLength(1);
  });

  test("no wake when get_run already read the result", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    const info = await sendFrom(call);
    f.peer.finish("rt-1", "Sunny");
    advanceMinutes(1);
    await f.outbound.get(call.principal, info.runId);
    await f.runs.completeRun(f.system, call.runId, { status: "done" });

    await f.outbound.wakeDue(f.system);

    expect(await wakeRuns(call.sessionId)).toHaveLength(0);
  });

  test("an answer to a peer's own task is not sent back a second time", async () => {
    await f.connectPeer();
    const call = await f.callingRun({
      reply: { kind: "a2a", taskId: "t-1" },
    });
    await sendFrom(call);
    await f.runs.completeRun(f.system, call.runId, { status: "done" });
    f.peer.finish("rt-1", "Sunny");
    advanceMinutes(2);

    await f.outbound.pollDue(f.system);

    const [wake] = await wakeRuns(call.sessionId);
    expect(JSON.parse(String(wake?.reply))).toEqual({ kind: "none" });
  });

  test("a wake counts against the hourly limit", async () => {
    await f.connectPeer({ hourlyLimit: 2 });
    const call = await f.callingRun();
    await sendFrom(call, "req-1");
    await f.runs.completeRun(f.system, call.runId, { status: "done" });
    f.peer.finish("rt-1", "Sunny");
    advanceMinutes(2);
    await f.outbound.pollDue(f.system);
    expect(await wakeRuns(call.sessionId)).toHaveLength(1);

    const error = await rejects(sendFrom(call, "req-2"));

    expect(error).toBeInstanceOf(A2aRateLimitError);
  });

  test("a wake that would pass the limit waits for a later tick", async () => {
    await f.connectPeer({ hourlyLimit: 1 });
    const call = await f.callingRun();
    await sendFrom(call, "req-1");
    await f.runs.completeRun(f.system, call.runId, { status: "done" });
    f.peer.finish("rt-1", "Sunny");
    advanceMinutes(2);

    await f.outbound.pollDue(f.system);
    expect(await wakeRuns(call.sessionId)).toHaveLength(0);

    advanceMinutes(61);
    await f.outbound.wakeDue(f.system);
    expect(await wakeRuns(call.sessionId)).toHaveLength(1);
  });

  test("a revoke fails open tasks and wakes nothing", async () => {
    await f.connectPeer();
    const call = await f.callingRun();
    const info = await sendFrom(call);
    await f.runs.completeRun(f.system, call.runId, { status: "done" });

    await f.connections.revoke(member(), OUTBOUND_CONNECTION);
    await f.outbound.wakeDue(f.system);

    const row = await rowOf(info.runId);
    expect(row.state).toBe("TASK_STATE_FAILED");
    expect(row.resultText).toBe("The connection was revoked.");
    expect(await wakeRuns(call.sessionId)).toHaveLength(0);
  });
});

describe("a Harbourmaster peer", () => {
  test("the call goes to the peer's /rpc under the origin from the invite", async () => {
    await f.connectPeer({
      outboundScheme: "bearer",
      peerCard: null,
      peerCardUrl: "https://peer.test/a2a/pub_x/.well-known/agent-card.json",
      peerKind: "harbourmaster",
    });
    const call = await f.callingRun();

    await sendFrom(call);

    expect(f.peer.calls.at(0)?.url).toBe("https://peer.test/a2a/pub_x/rpc");
    expect(f.peer.calls.at(0)?.authorization).toBe("Bearer peer-secret");
  });
});
