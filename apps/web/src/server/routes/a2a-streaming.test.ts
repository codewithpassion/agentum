// biome-ignore-all lint/suspicious/noMisplacedAssertion: the frame and refusal helpers assert inside the tests that call them.
// Streaming and blocking calls on the `/a2a` routes, over both bindings: the
// SSE frames, how a stream starts, moves and closes, what a subscription
// refuses before it starts, and how a blocking send waits. Every stream is
// read to its end, so a stream that never closes fails within two seconds.
import { beforeEach, describe, expect, test } from "bun:test";
import { a2aTasks } from "@repo/db/schema/a2a";
import type { A2aTaskState } from "@repo/db/shared";
import { eq } from "drizzle-orm";
import {
  type A2aFixture,
  createA2aFixture,
  textMessage,
} from "./a2a-fixture.ts";

const TIMING = { blockMs: 300, pollMs: 20, streamMs: 300 };
const STREAM_TIMEOUT_MS = 2000;
const MOVE_AFTER_MS = 60;

type Kind = "rest" | "rpc";

/** One way a client calls. `verb` is the HTTP method of a REST call; JSON-RPC is always a POST. */
interface Call {
  kind: Kind;
  name: string;
  verb: "GET" | "POST";
}

const STREAM_SENDS: Call[] = [
  { kind: "rpc", name: "JSON-RPC SendStreamingMessage", verb: "POST" },
  { kind: "rest", name: "HTTP+JSON POST /message:stream", verb: "POST" },
];

const SUBSCRIBES: Call[] = [
  { kind: "rpc", name: "JSON-RPC SubscribeToTask", verb: "POST" },
  { kind: "rest", name: "HTTP+JSON GET /tasks/{id}:subscribe", verb: "GET" },
  { kind: "rest", name: "HTTP+JSON POST /tasks/{id}:subscribe", verb: "POST" },
];

const BLOCKING_SENDS: Call[] = [
  { kind: "rpc", name: "JSON-RPC SendMessage", verb: "POST" },
  { kind: "rest", name: "HTTP+JSON POST /message:send", verb: "POST" },
];

interface Part {
  text?: string;
}

interface StatusBody {
  message?: { parts: Part[] };
  state: string;
}

interface TaskBody {
  artifacts?: { parts: Part[] }[];
  id: string;
  status: StatusBody;
}

/** One `StreamResponse`: exactly one of its members is set. */
interface Event {
  artifactUpdate?: {
    artifact: { parts: Part[] };
    lastChunk?: boolean;
    taskId: string;
  };
  statusUpdate?: { status: StatusBody; taskId: string };
  task?: TaskBody;
}

type Frame = Record<string, unknown>;

interface Session {
  agentId: string;
  connectionId: string;
  publicId: string;
  token: string;
}

let f: A2aFixture;

beforeEach(async () => {
  f = await createA2aFixture({ timing: TIMING });
});

/** A published agent and one connection to it, under the given inbound policy. */
const session = async (
  inbound: "approve" | "auto" = "auto"
): Promise<Session> => {
  const agent = await f.publish("stream");
  const key = await f.connect(agent, inbound);
  return {
    agentId: agent.agentId,
    connectionId: key.connectionId,
    publicId: agent.publicId,
    token: key.token,
  };
};

const sendStream = (call: Call, s: Session, messageId: string, text: string) =>
  call.kind === "rpc"
    ? f.rpc(
        s.publicId,
        s.token,
        "SendStreamingMessage",
        textMessage(messageId, text)
      )
    : f.rest(
        s.publicId,
        s.token,
        "POST",
        "/message:stream",
        textMessage(messageId, text)
      );

const sendBlocking = (
  call: Call,
  s: Session,
  messageId: string,
  text: string,
  configuration?: { returnImmediately: boolean }
) => {
  const body = {
    ...textMessage(messageId, text),
    ...(configuration === undefined ? {} : { configuration }),
  };
  return call.kind === "rpc"
    ? f.rpc(s.publicId, s.token, "SendMessage", body)
    : f.rest(s.publicId, s.token, "POST", "/message:send", body);
};

const subscribe = (call: Call, s: Session, taskId: string) =>
  call.kind === "rpc"
    ? f.rpc(s.publicId, s.token, "SubscribeToTask", { id: taskId })
    : f.rest(s.publicId, s.token, call.verb, `/tasks/${taskId}:subscribe`);

/** Reads a stream to its end. A stream that does not close in time fails here. */
const readStream = async (res: Response): Promise<string> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`The stream did not close within ${STREAM_TIMEOUT_MS} ms`)
        ),
      STREAM_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([res.text(), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** The frames of a stream. Each must be one `data:` line followed by a blank line. */
const framesOf = (raw: string): Frame[] => {
  const blocks = raw.split("\n\n");
  expect(blocks.pop()).toBe("");
  return blocks.map((block) => {
    expect(block.startsWith("data: ")).toBe(true);
    expect(block.includes("\n")).toBe(false);
    return JSON.parse(block.slice("data: ".length)) as Frame;
  });
};

/** The `StreamResponse` in each frame, which JSON-RPC wraps in `result`. */
const eventsOf = (call: Call, frames: Frame[]): Event[] =>
  frames.map((frame) => (call.kind === "rpc" ? frame.result : frame) as Event);

/** A member of an event. A test that expects it fails here when it is missing. */
const member = <K extends keyof Event>(
  event: Event | undefined,
  key: K
): NonNullable<Event[K]> => {
  const value = event?.[key];
  if (value === undefined) {
    throw new Error(`The event has no ${String(key)}`);
  }
  return value;
};

const kindsOf = (events: Event[]): string[] =>
  events.map((event) => Object.keys(event)[0] ?? "");

/** The fake runtime answers `Echo: ` and the message as a JSON envelope. */
const expectEcho = (text: string | undefined, input: string) => {
  expect(text?.startsWith("Echo: ")).toBe(true);
  expect(text).toContain(`"text":${JSON.stringify(input)}`);
};

const textOf = (status: StatusBody): string | undefined =>
  status.message?.parts[0]?.text;

/** The task of a blocking call's answer. */
const taskOf = async (call: Call, res: Response): Promise<TaskBody> => {
  const body = (await res.json()) as Frame;
  const payload = call.kind === "rpc" ? body.result : body;
  return (payload as { task: TaskBody }).task;
};

/** A stream's frames keep the binding's envelope: JSON-RPC carries `id` and `result`, REST carries the event. */
const expectEnvelope = (call: Call, frames: Frame[]) => {
  for (const frame of frames) {
    if (call.kind === "rpc") {
      expect(Object.keys(frame).sort()).toEqual(["id", "jsonrpc", "result"]);
      expect(frame.jsonrpc).toBe("2.0");
      expect(frame.id).toBe(1);
      expect(Object.keys(frame.result as Frame)).toHaveLength(1);
    } else {
      expect(Object.keys(frame)).toHaveLength(1);
    }
  }
};

/** Moves a task after a short wait, as a run would, and resolves once the move is saved. */
const moveLater = (
  taskId: string,
  state: A2aTaskState,
  extra: { resultText?: string; statusText?: string } = {},
  ms = MOVE_AFTER_MS
) =>
  new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      f.moveTask(taskId, state, extra).then(resolve, reject);
    }, ms);
  });

/** The message id a task was made with, to send again and get the same task back. */
const messageIdOf = (taskId: string): string => {
  const row = f.db.select().from(a2aTasks).where(eq(a2aTasks.id, taskId)).get();
  if (!row) {
    throw new Error(`No task ${taskId}`);
  }
  return row.messageId;
};

/** The refusal a subscription answers before any stream starts: an ordinary JSON error. */
interface Refusal {
  grpcStatus: string;
  httpStatus: number;
  reason: string;
  rpcCode: number;
}

const expectRefusal = async (call: Call, res: Response, want: Refusal) => {
  expect(res.headers.get("content-type")).not.toContain("text/event-stream");
  if (call.kind === "rpc") {
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error: { code: number; data: { reason: string }[] };
    };
    expect(body.error.code).toBe(want.rpcCode);
    expect(body.error.data[0]?.reason).toBe(want.reason);
    return;
  }
  expect(res.status).toBe(want.httpStatus);
  const body = (await res.json()) as {
    error: { details: { reason: string }[]; status: string };
  };
  expect(body.error.status).toBe(want.grpcStatus);
  expect(body.error.details[0]?.reason).toBe(want.reason);
};

const UNSUPPORTED: Refusal = {
  grpcStatus: "UNIMPLEMENTED",
  httpStatus: 400,
  reason: "UNSUPPORTED_OPERATION",
  rpcCode: -32_004,
};

const NOT_FOUND: Refusal = {
  grpcStatus: "NOT_FOUND",
  httpStatus: 404,
  reason: "TASK_NOT_FOUND",
  rpcCode: -32_001,
};

describe("streaming sends", () => {
  for (const call of STREAM_SENDS) {
    describe(call.name, () => {
      test("the stream is text/event-stream, one data line and a blank line per frame, with the binding's envelope", async () => {
        const s = await session("auto");
        const res = await sendStream(call, s, "m-frame", "hi");
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/event-stream");
        const raw = await readStream(res);
        expect(raw.startsWith("data: ")).toBe(true);
        const frames = framesOf(raw);
        expect(frames).toHaveLength(1);
        expectEnvelope(call, frames);
      });

      test("on an auto connection the first event is the completed task with its result, and the stream closes", async () => {
        const s = await session("auto");
        const events = eventsOf(
          call,
          framesOf(await readStream(await sendStream(call, s, "m-auto", "hi")))
        );
        expect(kindsOf(events)).toEqual(["task"]);
        const task = member(events[0], "task");
        expect(task.status.state).toBe("TASK_STATE_COMPLETED");
        expectEcho(task.artifacts?.[0]?.parts[0]?.text, "hi");
      });

      test("on an approve connection the first event is the task in AUTH_REQUIRED, and the stream closes there", async () => {
        const s = await session("approve");
        const events = eventsOf(
          call,
          framesOf(await readStream(await sendStream(call, s, "m-appr", "hi")))
        );
        expect(kindsOf(events)).toEqual(["task"]);
        expect(member(events[0], "task").status.state).toBe(
          "TASK_STATE_AUTH_REQUIRED"
        );
      });
    });
  }
});

describe("subscriptions", () => {
  for (const call of SUBSCRIBES) {
    describe(call.name, () => {
      test("the frames keep the framing and envelope of the binding", async () => {
        const s = await session("auto");
        const taskId = await f.seedTask(s.connectionId, "TASK_STATE_WORKING");
        const res = await subscribe(call, s, taskId);
        expect(res.headers.get("content-type")).toBe("text/event-stream");
        const moving = moveLater(taskId, "TASK_STATE_COMPLETED", {
          resultText: "Done.",
        });
        const frames = framesOf(await readStream(res));
        await moving;
        expect(frames).toHaveLength(3);
        expectEnvelope(call, frames);
      });

      test("when the task completes the stream carries the artifact, then the completed status, then closes", async () => {
        const s = await session("auto");
        const taskId = await f.seedTask(s.connectionId, "TASK_STATE_WORKING");
        const res = await subscribe(call, s, taskId);
        const moving = moveLater(taskId, "TASK_STATE_COMPLETED", {
          resultText: "Done.",
        });
        const events = eventsOf(call, framesOf(await readStream(res)));
        await moving;
        expect(kindsOf(events)).toEqual([
          "task",
          "artifactUpdate",
          "statusUpdate",
        ]);
        expect(member(events[0], "task").status.state).toBe(
          "TASK_STATE_WORKING"
        );
        const artifact = member(events[1], "artifactUpdate");
        expect(artifact.artifact.parts[0]?.text).toBe("Done.");
        expect(artifact.lastChunk).toBe(true);
        expect(artifact.taskId).toBe(taskId);
        const status = member(events[2], "statusUpdate");
        expect(status.status.state).toBe("TASK_STATE_COMPLETED");
        expect(status.taskId).toBe(taskId);
      });

      test("a subscription to a task that waits for input stays open until the task ends", async () => {
        const s = await session("auto");
        const taskId = await f.seedTask(
          s.connectionId,
          "TASK_STATE_INPUT_REQUIRED",
          { statusText: "Which file should I use?" }
        );
        const res = await subscribe(call, s, taskId);
        const started = Date.now();
        const moving = moveLater(taskId, "TASK_STATE_COMPLETED", {
          resultText: "Done.",
        });
        const events = eventsOf(call, framesOf(await readStream(res)));
        await moving;
        expect(kindsOf(events)).toEqual([
          "task",
          "artifactUpdate",
          "statusUpdate",
        ]);
        expect(member(events[0], "task").status.state).toBe(
          "TASK_STATE_INPUT_REQUIRED"
        );
        expect(member(events[2], "statusUpdate").status.state).toBe(
          "TASK_STATE_COMPLETED"
        );
        // It closed at the terminal state, not because the stream ran out of time.
        expect(Date.now() - started).toBeLessThan(TIMING.streamMs);
      });

      test("when the task asks for input the stream carries the status update with the status text", async () => {
        const s = await session("auto");
        const taskId = await f.seedTask(s.connectionId, "TASK_STATE_WORKING");
        const res = await subscribe(call, s, taskId);
        const moving = moveLater(taskId, "TASK_STATE_INPUT_REQUIRED", {
          statusText: "Which file should I use?",
        });
        const events = eventsOf(call, framesOf(await readStream(res)));
        await moving;
        expect(kindsOf(events)).toEqual(["task", "statusUpdate"]);
        const { status } = member(events[1], "statusUpdate");
        expect(status.state).toBe("TASK_STATE_INPUT_REQUIRED");
        expect(textOf(status)).toBe("Which file should I use?");
      });

      test("a stream on a task that stays working closes by itself after streamMs, with only the task", async () => {
        const s = await session("auto");
        const taskId = await f.seedTask(s.connectionId, "TASK_STATE_WORKING");
        const started = Date.now();
        const events = eventsOf(
          call,
          framesOf(await readStream(await subscribe(call, s, taskId)))
        );
        expect(Date.now() - started).toBeGreaterThanOrEqual(TIMING.streamMs);
        expect(kindsOf(events)).toEqual(["task"]);
        expect(member(events[0], "task").status.state).toBe(
          "TASK_STATE_WORKING"
        );
      });

      test("subscribing again after the task moved on shows the new state", async () => {
        const s = await session("auto");
        const taskId = await f.seedTask(s.connectionId, "TASK_STATE_WORKING");
        await readStream(await subscribe(call, s, taskId));
        await f.moveTask(taskId, "TASK_STATE_INPUT_REQUIRED", {
          statusText: "Which file should I use?",
        });
        const events = eventsOf(
          call,
          framesOf(await readStream(await subscribe(call, s, taskId)))
        );
        expect(kindsOf(events)).toEqual(["task"]);
        const task = member(events[0], "task");
        expect(task.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
        expect(textOf(task.status)).toBe("Which file should I use?");
      });

      test("a task that already ended is UnsupportedOperationError, not a stream", async () => {
        const s = await session("auto");
        const taskId = await f.seedTask(
          s.connectionId,
          "TASK_STATE_COMPLETED",
          {
            resultText: "Done.",
          }
        );
        await expectRefusal(
          call,
          await subscribe(call, s, taskId),
          UNSUPPORTED
        );
      });

      test("an unknown task is TaskNotFoundError, not a stream", async () => {
        const s = await session("auto");
        await expectRefusal(
          call,
          await subscribe(call, s, "tsk_missing"),
          NOT_FOUND
        );
      });

      test("another connection's task is TaskNotFoundError, not a stream", async () => {
        const s = await session("auto");
        const other = await f.connect(
          { agentId: s.agentId, publicId: s.publicId },
          "auto",
          "Other"
        );
        const taskId = await f.seedTask(s.connectionId, "TASK_STATE_WORKING");
        await expectRefusal(
          call,
          await subscribe(call, { ...s, token: other.token }, taskId),
          NOT_FOUND
        );
      });

      test("a stream whose connection is revoked ends with an error frame for the binding, then closes", async () => {
        const s = await session("auto");
        const taskId = await f.seedTask(s.connectionId, "TASK_STATE_WORKING");
        const res = await subscribe(call, s, taskId);
        const revoking = new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            f.composed.services.connections
              .revoke(f.member, s.connectionId)
              .then(() => resolve(), reject);
          }, MOVE_AFTER_MS);
        });
        const frames = framesOf(await readStream(res));
        await revoking;
        expect(frames).toHaveLength(2);
        const [, error] = frames;
        if (call.kind === "rpc") {
          expect(error).toEqual({
            error: { code: -32_000, message: "Authentication is required." },
            id: 1,
            jsonrpc: "2.0",
          });
        } else {
          expect(error).toEqual({
            error: {
              code: 401,
              details: [],
              message: "Authentication is required.",
              status: "UNAUTHENTICATED",
            },
          });
        }
      });
    });
  }
});

describe("blocking sends", () => {
  for (const call of BLOCKING_SENDS) {
    describe(call.name, () => {
      test("on an auto connection the answer is the completed task", async () => {
        const s = await session("auto");
        const res = await sendBlocking(call, s, "m-block", "hi");
        expect(res.status).toBe(200);
        const task = await taskOf(call, res);
        expect(task.status.state).toBe("TASK_STATE_COMPLETED");
        expectEcho(task.artifacts?.[0]?.parts[0]?.text, "hi");
      });

      test("with returnImmediately an approve connection answers at once in AUTH_REQUIRED", async () => {
        const s = await session("approve");
        const started = Date.now();
        const task = await taskOf(
          call,
          await sendBlocking(call, s, "m-now", "hi", {
            returnImmediately: true,
          })
        );
        expect(Date.now() - started).toBeLessThan(TIMING.blockMs);
        expect(task.status.state).toBe("TASK_STATE_AUTH_REQUIRED");
      });

      test("without returnImmediately an approve connection still answers at once, with the waiting message", async () => {
        const s = await session("approve");
        const started = Date.now();
        const task = await taskOf(
          call,
          await sendBlocking(call, s, "m-wait", "hi")
        );
        expect(Date.now() - started).toBeLessThan(TIMING.blockMs);
        expect(task.status.state).toBe("TASK_STATE_AUTH_REQUIRED");
        const text = task.status.message?.parts[0]?.text;
        expect(text?.startsWith("Waiting for a person")).toBe(true);
      });

      test("a send that finds a working task waits blockMs, then answers with the task as it stands", async () => {
        const s = await session("auto");
        const taskId = await f.seedTask(s.connectionId, "TASK_STATE_WORKING");
        const started = Date.now();
        const task = await taskOf(
          call,
          await sendBlocking(call, s, messageIdOf(taskId), "again")
        );
        expect(Date.now() - started).toBeGreaterThanOrEqual(TIMING.blockMs);
        expect(task.id).toBe(taskId);
        expect(task.status.state).toBe("TASK_STATE_WORKING");
      });

      test("a send that finds a working task answers as soon as the task settles", async () => {
        const s = await session("auto");
        const taskId = await f.seedTask(s.connectionId, "TASK_STATE_WORKING");
        const moving = moveLater(taskId, "TASK_STATE_COMPLETED", {
          resultText: "Done.",
        });
        const started = Date.now();
        const task = await taskOf(
          call,
          await sendBlocking(call, s, messageIdOf(taskId), "again")
        );
        await moving;
        expect(Date.now() - started).toBeLessThan(TIMING.blockMs);
        expect(task.status.state).toBe("TASK_STATE_COMPLETED");
        expect(task.artifacts?.[0]?.parts[0]?.text).toBe("Done.");
      });
    });
  }
});

describe("a quiet stream's lifetime", () => {
  const SUBSCRIBE_RPC = SUBSCRIBES[0] as Call;
  const SUBSCRIBE_GET = SUBSCRIBES[1] as Call;

  test("a stream with nothing to say sends keepalive comments, and the frames still parse", async () => {
    f = await createA2aFixture({
      timing: { blockMs: 300, heartbeatMs: 30, pollMs: 10, streamMs: 200 },
    });
    const s = await session("auto");
    const taskId = await f.seedTask(s.connectionId, "TASK_STATE_WORKING");
    const raw = await readStream(await subscribe(SUBSCRIBE_GET, s, taskId));
    expect(raw).toContain(": keepalive\n\n");
    const data = raw
      .split("\n\n")
      .filter((block) => block.startsWith("data: "))
      .join("\n\n");
    expect(kindsOf(eventsOf(SUBSCRIBE_GET, framesOf(`${data}\n\n`)))).toEqual([
      "task",
    ]);
  });

  for (const call of [SUBSCRIBE_RPC, SUBSCRIBE_GET]) {
    test(`${call.name}: a client that goes away stops the stream at once`, async () => {
      f = await createA2aFixture({
        timing: { blockMs: 300, pollMs: 10, streamMs: 5000 },
      });
      const s = await session("auto");
      const taskId = await f.seedTask(s.connectionId, "TASK_STATE_WORKING");
      const res = await subscribe(call, s, taskId);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      const started = Date.now();
      await reader.cancel();
      expect(Date.now() - started).toBeLessThan(500);
    });
  }
});
