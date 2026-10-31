// The A2A operations, once. The JSON-RPC and the HTTP+JSON binding both turn a
// request into the same `(operation, params)` pair and call `runOperation`, so
// what an operation does can't drift between them. A binding only words the
// answer: `body` is the result, `stream` is a run of `StreamResponse` events.
import type { JsonRpcMethod } from "@repo/a2a/jsonrpc";
import {
  type SendMessageRequest,
  sendMessageRequestSchema,
} from "@repo/a2a/requests";
import { isSettledTaskState, isTerminalTaskState } from "@repo/a2a/states";
import type { StreamResponse, Task } from "@repo/a2a/tasks";
import type { PeerPrincipal } from "@repo/services/a2a/connections";
import { A2aTaskError } from "@repo/services/a2a/errors";
import type { A2aTasksService } from "@repo/services/a2a/tasks";
import { z } from "zod";

export interface A2aTiming {
  /** SendMessage waits for a settled task at most this long. */
  blockMs: number;
  /** A quiet stream sends a comment this often, so nothing on the way closes it as idle. */
  heartbeatMs: number;
  /** How often the task row is read while waiting or streaming. */
  pollMs: number;
  /** A stream closes after this long, so the client resubscribes. */
  streamMs: number;
}

export const DEFAULT_TIMING: A2aTiming = {
  blockMs: 90_000,
  heartbeatMs: 30_000,
  pollMs: 2000,
  streamMs: 10 * 60_000,
};

/** What a stream yields besides an event: write a comment line, so the connection is not idle. */
export const HEARTBEAT = "heartbeat";
export type StreamItem = StreamResponse | typeof HEARTBEAT;

export type OperationOutcome =
  | { body: unknown; kind: "body" }
  | { events: AsyncIterable<StreamItem>; kind: "stream" };

interface OperationContext {
  peer: PeerPrincipal;
  signal: AbortSignal;
  tasks: A2aTasksService;
  timing: A2aTiming;
}

const paramsSchema = z.record(z.string(), z.unknown());

/** Resolves after `ms`, or as soon as `signal` aborts. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/** What a client sees change on a task: its state and what the status says. */
const fingerprint = (task: Task): string =>
  `${task.status.state}|${task.status.message?.parts[0]?.text ?? ""}`;

/** The events of a task's change: an artifact update for each new artifact, then the status. */
const changeEvents = (last: Task, task: Task): StreamResponse[] => {
  const contextId = task.contextId ?? task.id;
  const artifacts = (task.artifacts ?? []).filter(
    (artifact) =>
      !last.artifacts?.some((seen) => seen.artifactId === artifact.artifactId)
  );
  return [
    ...artifacts.map((artifact) => ({
      artifactUpdate: { artifact, contextId, lastChunk: true, taskId: task.id },
    })),
    { statusUpdate: { contextId, status: task.status, taskId: task.id } },
  ];
};

/**
 * The task first, then a status update each time the task changes, with an
 * artifact update ahead of the one that carries the result. It ends at a
 * settled state, after `timing.streamMs`, or when the client goes away.
 */
async function* taskEvents(
  initial: Task,
  read: () => Promise<Task>,
  { signal, timing }: Pick<OperationContext, "signal" | "timing">
): AsyncGenerator<StreamItem> {
  yield { task: initial };
  if (isSettledTaskState(initial.status.state)) {
    return;
  }
  const deadline = Date.now() + timing.streamMs;
  let last = initial;
  let lastWrite = Date.now();
  while (!signal.aborted && Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: each read follows the wait before it
    await sleep(Math.min(timing.pollMs, deadline - Date.now()), signal);
    if (signal.aborted) {
      return;
    }
    const task = await read();
    if (signal.aborted) {
      return;
    }
    if (fingerprint(task) === fingerprint(last)) {
      if (Date.now() - lastWrite >= timing.heartbeatMs) {
        lastWrite = Date.now();
        yield HEARTBEAT;
      }
      continue;
    }
    lastWrite = Date.now();
    yield* changeEvents(last, task);
    last = task;
    if (isSettledTaskState(task.status.state)) {
      return;
    }
  }
}

/** Waits for the task to settle, for at most `timing.blockMs`, then returns it as it stands. */
const settled = async (
  initial: Task,
  read: () => Promise<Task>,
  { signal, timing }: Pick<OperationContext, "signal" | "timing">
): Promise<Task> => {
  const deadline = Date.now() + timing.blockMs;
  let task = initial;
  while (
    !(signal.aborted || isSettledTaskState(task.status.state)) &&
    Date.now() < deadline
  ) {
    // biome-ignore lint/performance/noAwaitInLoops: each read follows the wait before it
    await sleep(Math.min(timing.pollMs, deadline - Date.now()), signal);
    task = await read();
  }
  return task;
};

const taskIdOf = (params: Record<string, unknown>): { id: string } =>
  z.object({ id: z.string().min(1) }).parse(params);

const pushRefOf = (params: Record<string, unknown>) =>
  z.object({ id: z.string().min(1), taskId: z.string().min(1) }).parse(params);

const send = async (
  { peer, tasks, ...rest }: OperationContext,
  request: SendMessageRequest,
  streaming: boolean
): Promise<OperationOutcome> => {
  const first = await tasks.sendMessage(peer, request);
  const historyLength = request.configuration?.historyLength;
  const read = () => tasks.getTask(peer, { historyLength, id: first.id });
  if (streaming) {
    return { events: taskEvents(first, read, rest), kind: "stream" };
  }
  const task = request.configuration?.returnImmediately
    ? first
    : await settled(first, read, rest);
  return { body: { task }, kind: "body" };
};

const subscribe = async (
  { peer, tasks, ...rest }: OperationContext,
  params: Record<string, unknown>
): Promise<OperationOutcome> => {
  const { id } = taskIdOf(params);
  const first = await tasks.getTask(peer, { id });
  if (isTerminalTaskState(first.status.state)) {
    throw new A2aTaskError(
      "UnsupportedOperationError",
      "The task has ended. Read it with GetTask."
    );
  }
  return {
    events: taskEvents(first, () => tasks.getTask(peer, { id }), rest),
    kind: "stream",
  };
};

const body = (value: unknown): OperationOutcome => ({
  body: value,
  kind: "body",
});

/**
 * Runs one operation for the authenticated peer. `params` is the request's
 * parameters as an object, wherever the binding found them. A refusal is thrown.
 */
export const runOperation = async (
  operation: JsonRpcMethod,
  rawParams: unknown,
  context: OperationContext
): Promise<OperationOutcome> => {
  const { peer, tasks } = context;
  const params = paramsSchema.parse(rawParams ?? {});
  switch (operation) {
    case "SendMessage":
      return await send(context, sendMessageRequestSchema.parse(params), false);
    case "SendStreamingMessage":
      return await send(context, sendMessageRequestSchema.parse(params), true);
    case "GetTask":
      return body(await tasks.getTask(peer, params as { id: string }));
    case "ListTasks":
      return body(await tasks.listTasks(peer, params));
    case "CancelTask":
      return body(await tasks.cancelTask(peer, taskIdOf(params)));
    case "SubscribeToTask":
      return await subscribe(context, params);
    case "CreateTaskPushNotificationConfig": {
      const { taskId, ...config } = params;
      return body(
        await tasks.createPushConfig(peer, {
          config: config as { url: string },
          taskId: z.string().min(1).parse(taskId),
        })
      );
    }
    case "GetTaskPushNotificationConfig":
      return body(await tasks.getPushConfig(peer, pushRefOf(params)));
    case "ListTaskPushNotificationConfigs": {
      const { taskId } = z.object({ taskId: z.string().min(1) }).parse(params);
      return body({
        configs: await tasks.listPushConfigs(peer, { taskId }),
        nextPageToken: "",
      });
    }
    case "DeleteTaskPushNotificationConfig":
      await tasks.deletePushConfig(peer, pushRefOf(params));
      return body({});
    case "GetExtendedAgentCard":
      throw new A2aTaskError(
        "ExtendedAgentCardNotConfiguredError",
        "This agent has no extended agent card."
      );
    default:
      throw new A2aTaskError(
        "UnsupportedOperationError",
        "This operation is not supported."
      );
  }
};
