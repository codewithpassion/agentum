#!/usr/bin/env bun
// Interop with the official A2A JavaScript SDK (`@a2a-js/sdk`, a dev
// dependency), in both directions, against a real `vite dev` Worker:
//
//   1. The SDK is the client and we are the server. For each binding (JSON-RPC
//      and HTTP+JSON): fetch the card, send and block, block at input-required
//      and answer, stream, resubscribe, get, list, cancel, and a push config
//      against a local receiver (CRUD, then a real delivery).
//   2. We are the client and the SDK is the server. The SDK's own sample agent
//      (`src/samples/agents/sample-agent` of the SDK checkout) runs on its
//      fixed port, one of our agents is connected to it through "Call it", and
//      a run of that agent sends it a message with the `send_message` tool.
//
// The SDK checkout is third-party code and lives in its own folder under the
// work folder (the script clones tag v1.3.0 and runs `npm install` there on
// first use). Run from the repo root:
//
//   bun scripts/e2e/a2a-interop.ts [--work-dir <dir>] [--sdk-dir <dir>]
//     [--server <origin>] [--part sdk-client|sdk-server]
//
// `--server` uses a deployment that is already running and stops nothing.
// Exit code 0 when every check passed. The summary lines go into
// docs/reviews/tasks/AA.8.md.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SendMessageRequest, TaskState } from "@a2a-js/sdk";
import {
  ClientFactory,
  ClientFactoryOptions,
  createAuthenticatingFetchWithRetry,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from "@a2a-js/sdk/client";
import { file, type Subprocess, serve, spawn } from "bun";
import {
  type AccessKey,
  attachDeployment,
  createDeployment,
  type Deployment,
  defaultWorkDir,
  E2eError,
  freePort,
  giveKey,
  type PublishedAgent,
  publishAgent,
  sleep,
  waitUntil,
} from "./a2a-harness.ts";

const SDK_REPO = "https://github.com/a2aproject/a2a-js";
const SDK_TAG = "v1.3.0";
/** The SDK sample agent's card names this port, so the script cannot choose another. */
const SAMPLE_PORT = 41_241;
const HOURLY_LIMIT = 10_000;
const SLOW_MS = 60_000;
const PUSH_TOKEN = "interop-push-token";
const PUSH_BEARER = "interop-push-bearer";

type SdkClient = Awaited<ReturnType<ClientFactory["createFromUrl"]>>;
type Binding = "HTTP+JSON" | "JSONRPC";

// ---------------------------------------------------------------------------
// Checks

interface Result {
  detail: string;
  name: string;
  ok: boolean;
}

const results: Result[] = [];

const check = async (
  name: string,
  body: () => Promise<string | undefined>
): Promise<void> => {
  const started = Date.now();
  try {
    const detail = (await body()) ?? "";
    results.push({ detail, name, ok: true });
    console.log(
      `ok    ${name}${detail ? ` (${detail})` : ""} ${Date.now() - started} ms`
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ detail, name, ok: false });
    console.log(`FAIL  ${name}: ${detail}`);
  }
};

const expect = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new E2eError(message);
  }
};

// ---------------------------------------------------------------------------
// Small SDK helpers

const textRequest = (
  text: string,
  options: {
    contextId?: string;
    returnImmediately?: boolean;
    taskId?: string;
    taskPushNotificationConfig?: Record<string, unknown>;
  } = {}
): SendMessageRequest =>
  SendMessageRequest.fromJSON({
    configuration:
      options.returnImmediately || options.taskPushNotificationConfig
        ? {
            returnImmediately: options.returnImmediately ?? false,
            ...(options.taskPushNotificationConfig
              ? {
                  taskPushNotificationConfig:
                    options.taskPushNotificationConfig,
                }
              : {}),
          }
        : undefined,
    message: {
      ...(options.contextId ? { contextId: options.contextId } : {}),
      messageId: crypto.randomUUID(),
      parts: [{ text }],
      role: "ROLE_USER",
      ...(options.taskId ? { taskId: options.taskId } : {}),
    },
  });

interface TaskLike {
  artifacts: { parts: { content?: { $case: string; value: unknown } }[] }[];
  contextId: string;
  history: unknown[];
  id: string;
  status?: { state: TaskState };
}

const asTask = (result: unknown): TaskLike => {
  const task = result as Partial<TaskLike>;
  expect(task.id && task.status, "the answer is not a task");
  return task as TaskLike;
};

const artifactText = (task: TaskLike): string =>
  task.artifacts
    .flatMap((artifact) => artifact.parts)
    .map((part) =>
      part.content?.$case === "text" ? String(part.content.value) : ""
    )
    .join("");

const stateOf = (task: TaskLike): string =>
  TaskState[task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED] ?? "?";

const expectState = (task: TaskLike, want: TaskState, what: string): void => {
  expect(
    task.status?.state === want,
    `${what}: expected ${TaskState[want]}, got ${stateOf(task)}`
  );
};

/** The SDK client for one binding of an agent, speaking as the access key. */
const sdkClient = async (
  agent: PublishedAgent,
  key: AccessKey,
  binding: Binding
): Promise<SdkClient> => {
  const authed = createAuthenticatingFetchWithRetry(fetch, {
    headers: () => Promise.resolve({ Authorization: `Bearer ${key.token}` }),
    shouldRetryWithHeaders: () => Promise.resolve(undefined),
  });
  const options = ClientFactoryOptions.createFrom(
    ClientFactoryOptions.default,
    {
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: authed }),
      preferredTransports: [binding],
      transports: [
        new JsonRpcTransportFactory({ fetchImpl: authed }),
        new RestTransportFactory({ fetchImpl: authed }),
      ],
    }
  );
  // The card is not at the host's root, so its whole URL goes in with no path.
  return await new ClientFactory(options).createFromUrl(agent.cardUrl, "");
};

// ---------------------------------------------------------------------------
// A webhook receiver for push notifications

interface Receiver {
  received: { body: unknown; headers: Headers }[];
  stop: () => void;
  url: string;
}

const startReceiver = async (): Promise<Receiver> => {
  const received: Receiver["received"] = [];
  const port = await freePort();
  const server = serve({
    fetch: async (request) => {
      received.push({
        body: await request.json().catch(() => null),
        headers: request.headers,
      });
      return new Response("ok");
    },
    port,
  });
  return {
    received,
    stop: () => server.stop(true),
    url: `http://localhost:${port}/hook`,
  };
};

// ---------------------------------------------------------------------------
// 1. The SDK calls us

const sdkCallsUs = async (
  deployment: Deployment,
  agent: PublishedAgent,
  key: AccessKey,
  binding: Binding
): Promise<void> => {
  const label = binding === "JSONRPC" ? "json-rpc" : "http+json";
  const client = await sdkClient(agent, key, binding);
  const tag = (name: string) => `sdk -> us, ${label}: ${name}`;

  await check(tag("card"), async () => {
    const card = await new DefaultAgentCardResolver().resolve(
      agent.cardUrl,
      ""
    );
    const bindings = card.supportedInterfaces.map(
      (entry) => entry.protocolBinding
    );
    expect(
      bindings.includes("JSONRPC") && bindings.includes("HTTP+JSON"),
      `the card lists ${bindings.join(", ")}`
    );
    expect(card.capabilities?.streaming, "the card does not declare streaming");
    expect(
      client.protocolVersion === "1.0",
      `client speaks ${client.protocolVersion}`
    );
    return `${card.name}, ${bindings.join(" and ")}`;
  });

  await check(tag("send, blocking"), async () => {
    const task = asTask(await client.sendMessage(textRequest("say pong")));
    expectState(task, TaskState.TASK_STATE_COMPLETED, "send");
    expect(
      artifactText(task) === "pong",
      `artifact text is "${artifactText(task)}"`
    );
    return `task ${task.id}`;
  });

  await check(tag("block at input-required, then answer"), async () => {
    const first = asTask(
      await client.sendMessage(textRequest("ask Which colour?"))
    );
    expectState(first, TaskState.TASK_STATE_INPUT_REQUIRED, "first send");
    const second = asTask(
      await client.sendMessage(
        textRequest("blue", { contextId: first.contextId, taskId: first.id })
      )
    );
    expect(second.id === first.id, "the answer started another task");
    expectState(second, TaskState.TASK_STATE_COMPLETED, "answer");
    expect(
      artifactText(second).includes("blue"),
      "the answer did not reach the run"
    );
    return "asked, answered, completed";
  });

  await check(tag("stream"), async () => {
    const states: string[] = [];
    let text = "";
    for await (const event of client.sendMessageStream(
      textRequest("say streamed")
    )) {
      const { payload } = event;
      if (payload?.$case === "task") {
        states.push(stateOf(payload.value as TaskLike));
        text += artifactText(payload.value as TaskLike);
      } else if (payload?.$case === "statusUpdate") {
        states.push(TaskState[payload.value.status?.state ?? 0] ?? "?");
      } else if (payload?.$case === "artifactUpdate") {
        text += payload.value.artifact?.parts
          .map((part) =>
            part.content?.$case === "text" ? part.content.value : ""
          )
          .join("");
      }
    }
    expect(
      states.at(-1) === "TASK_STATE_COMPLETED",
      `the stream ended at ${states.at(-1)}`
    );
    expect(
      text.includes("streamed"),
      `no artifact text in the stream: "${text}"`
    );
    return states.join(" > ");
  });

  const slow: { task?: TaskLike } = {};
  const slowTask = (): TaskLike => {
    if (!slow.task) {
      throw new E2eError("the resubscribe check made no task");
    }
    return slow.task;
  };
  await check(tag("resubscribe to a running task"), async () => {
    slow.task = asTask(
      await client.sendMessage(textRequest("slow", { returnImmediately: true }))
    );
    expect(
      slow.task.status?.state !== TaskState.TASK_STATE_COMPLETED,
      "the slow run had already finished"
    );
    let last = "";
    for await (const event of client.resubscribeTask({
      id: slow.task.id,
      tenant: "",
    })) {
      if (event.payload?.$case === "statusUpdate") {
        last = TaskState[event.payload.value.status?.state ?? 0] ?? "?";
      }
    }
    expect(last === "TASK_STATE_COMPLETED", `the stream ended at ${last}`);
    return `task ${slow.task.id}`;
  });

  await check(tag("get"), async () => {
    const task = asTask(
      await client.getTask({
        historyLength: 10,
        id: slowTask().id,
        tenant: "",
      })
    );
    expectState(task, TaskState.TASK_STATE_COMPLETED, "get");
    expect(task.history.length >= 1, "the task has no history");
    return `${task.history.length} history message(s)`;
  });

  await check(tag("list"), async () => {
    const listed = await client.listTasks({
      contextId: slowTask().contextId,
      includeArtifacts: false,
      pageToken: "",
      status: TaskState.TASK_STATE_UNSPECIFIED,
      tenant: "",
    } as Parameters<typeof client.listTasks>[0]);
    expect(
      listed.tasks.some((task) => task.id === slow.task?.id),
      "the task is not in its context's list"
    );
    return `${listed.tasks.length} task(s)`;
  });

  await check(tag("cancel"), async () => {
    const running = asTask(
      await client.sendMessage(textRequest("slow", { returnImmediately: true }))
    );
    const cancelled = asTask(
      await client.cancelTask({ id: running.id, tenant: "" })
    );
    expectState(cancelled, TaskState.TASK_STATE_CANCELED, "cancel");
    return `task ${running.id}`;
  });

  await check(tag("push config, create, get, list, delete"), async () => {
    const receiver = await startReceiver();
    try {
      const running = asTask(
        await client.sendMessage(
          textRequest("slow", { returnImmediately: true })
        )
      );
      const created = await client.createTaskPushNotificationConfig({
        authentication: { credentials: PUSH_BEARER, scheme: "Bearer" },
        id: "interop-config",
        taskId: running.id,
        tenant: "",
        token: PUSH_TOKEN,
        url: receiver.url,
      });
      expect(created.id === "interop-config", `created id ${created.id}`);
      const got = await client.getTaskPushNotificationConfig({
        id: created.id,
        taskId: running.id,
        tenant: "",
      });
      expect(got.url === receiver.url, "get returned another url");
      const listed = await client.listTaskPushNotificationConfig({
        pageSize: 10,
        pageToken: "",
        taskId: running.id,
        tenant: "",
      });
      expect(
        listed.configs.length === 1,
        `${listed.configs.length} configs listed`
      );
      await client.deleteTaskPushNotificationConfig({
        id: created.id,
        taskId: running.id,
        tenant: "",
      });
      const after = await client.listTaskPushNotificationConfig({
        pageSize: 10,
        pageToken: "",
        taskId: running.id,
        tenant: "",
      });
      expect(after.configs.length === 0, "the config is still listed");
      await client.cancelTask({ id: running.id, tenant: "" });
      return "created, read back, listed, deleted";
    } finally {
      receiver.stop();
    }
  });

  await check(
    tag("push notification delivered to a local receiver"),
    async () => {
      const receiver = await startReceiver();
      try {
        const running = asTask(
          await client.sendMessage(
            textRequest("say pushed", {
              returnImmediately: true,
              taskPushNotificationConfig: {
                authentication: { credentials: PUSH_BEARER, scheme: "Bearer" },
                id: "interop-inline",
                token: PUSH_TOKEN,
                url: receiver.url,
              },
            })
          )
        );
        await waitUntil(
          "a push notification",
          SLOW_MS,
          async () => {
            await deployment.tick();
            return receiver.received.length > 0;
          },
          2000
        );
        const [hit] = receiver.received;
        expect(
          hit?.headers.get("authorization") === `Bearer ${PUSH_BEARER}`,
          "the push did not carry the configured Authorization"
        );
        expect(
          hit?.headers.get("x-a2a-notification-token") === PUSH_TOKEN,
          "the push did not carry the token header"
        );
        const sentTask = JSON.stringify(hit?.body);
        expect(
          sentTask.includes(running.id),
          "the push body does not name the task"
        );
        return `${receiver.received.length} push(es) for task ${running.id}`;
      } finally {
        receiver.stop();
      }
    }
  );
};

// ---------------------------------------------------------------------------
// 2. We call the SDK's sample agent

const ensureSdk = async (dir: string): Promise<void> => {
  const run = async (cmd: string[], cwd: string) => {
    const proc = spawn(cmd, { cwd, stderr: "inherit", stdout: "inherit" });
    if ((await proc.exited) !== 0) {
      throw new E2eError(`${cmd.join(" ")} failed in ${cwd}`);
    }
  };
  if (!existsSync(join(dir, "package.json"))) {
    await run(
      [
        "git",
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--branch",
        SDK_TAG,
        SDK_REPO,
        dir,
      ],
      process.cwd()
    );
  }
  if (!existsSync(join(dir, "node_modules", ".bin", "tsx"))) {
    await run(["npm", "install", "--no-audit", "--no-fund"], dir);
  }
};

const startSample = async (
  dir: string,
  logFile: string
): Promise<Subprocess> => {
  const log = file(logFile);
  const proc = spawn(
    ["node_modules/.bin/tsx", "src/samples/agents/sample-agent/index.ts"],
    {
      cwd: dir,
      env: { ...process.env, PORT: String(SAMPLE_PORT) },
      stderr: log,
      stdout: log,
    }
  );
  await waitUntil("the SDK sample agent starting", 60_000, async () => {
    if (proc.exitCode !== null) {
      throw new E2eError(`the SDK sample agent exited with ${proc.exitCode}`);
    }
    return await fetch(
      `http://localhost:${SAMPLE_PORT}/.well-known/agent-card.json`
    ).then(
      (response) => response.ok,
      () => false
    );
  });
  return proc;
};

interface RunView {
  error: string | null;
  resultText: string | null;
  status: string;
}

const runAgent = async (
  deployment: Deployment,
  agentId: string,
  text: string
): Promise<RunView> => {
  const { runId } = await deployment.person.mutate<{ runId: string }>(
    "runs.start",
    {
      agentId,
      input: { text },
      session: { externalKey: `interop-${Date.now()}`, origin: "ui" },
    }
  );
  let view: RunView = { error: null, resultText: null, status: "queued" };
  await waitUntil("the run ending", 120_000, async () => {
    view = await deployment.person.query<RunView>("runs.get", { runId });
    return ["done", "failed", "cancelled", "interrupted"].includes(view.status);
  });
  return view;
};

const usCallSdk = async (
  deployment: Deployment,
  workDir: string,
  sdkDir: string
): Promise<void> => {
  const stateless = "us -> sdk sample agent";
  let sample: Subprocess | undefined;
  try {
    await ensureSdk(sdkDir);
    mkdirSync(workDir, { recursive: true });
    sample = await startSample(sdkDir, join(workDir, "sdk-sample.log"));
  } catch (error) {
    results.push({
      detail: error instanceof Error ? error.message : String(error),
      name: `${stateless}: start the SDK sample agent`,
      ok: false,
    });
    console.log(`FAIL  ${stateless}: ${results.at(-1)?.detail}`);
    sample?.kill();
    return;
  }
  try {
    const caller = await deployment.person.mutate<{ id: string }>(
      "agents.create",
      {
        instructions: "Call peers when asked.",
        model: "faux",
        name: "Interop Caller",
        runtime: "cloud",
        slug: `interop-caller-${Date.now()}`,
      }
    );
    let connection:
      | { id: string; peerLabel: string | null; slug: string }
      | undefined;
    await check(
      `${stateless}: Call it reads the card and connects`,
      async () => {
        connection = await deployment.person.mutate<
          NonNullable<typeof connection>
        >("a2a.addOutbound", {
          agentId: caller.id,
          cardUrl: `http://localhost:${SAMPLE_PORT}/.well-known/agent-card.json`,
          label: "SDK sample",
        });
        await deployment.person.mutate("a2a.setPolicies", {
          connectionId: connection.id,
          outboundPolicy: "auto",
        });
        return `${connection.peerLabel}, slug ${connection.slug}`;
      }
    );
    if (!connection) {
      return;
    }
    // A peer is listed under the label the person gave the connection.
    const slug = `${connection.slug}/sdk-sample`;
    await check(
      `${stateless}: a run sends a message and reads the answer`,
      async () => {
        const run = await runAgent(
          deployment,
          caller.id,
          `call harbourmaster_send_message ${JSON.stringify({ agent: slug, text: "hello from harbourmaster", waitMs: 20_000 })}`
        );
        expect(run.status === "done", `run ended ${run.status}: ${run.error}`);
        expect(
          run.resultText?.includes("Hello World! Nice to meet you!"),
          `the answer is not the sample agent's: ${run.resultText}`
        );
        return "the sample agent's reply came back through the connection";
      }
    );
  } finally {
    sample.kill();
  }
};

// ---------------------------------------------------------------------------

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    options: {
      part: { type: "string" },
      "sdk-dir": { type: "string" },
      server: { type: "string" },
      "work-dir": { type: "string" },
    },
  });
  const workDir = values["work-dir"] ?? defaultWorkDir();
  const sdkDir = values["sdk-dir"] ?? join(workDir, "a2a-js");
  mkdirSync(workDir, { recursive: true });
  const deployment = values.server
    ? attachDeployment(values.server)
    : createDeployment({ name: "interop", port: await freePort(), workDir });
  try {
    await deployment.start();
    const agent = await publishAgent(deployment.person, "Interop Agent");
    const key = await giveKey(deployment.person, agent, "sdk", {
      hourlyLimit: HOURLY_LIMIT,
      inboundPolicy: "auto",
    });
    // `--part sdk-client` or `--part sdk-server` runs one half, for working on it.
    const runClient = values.part !== "sdk-server";
    for (const binding of runClient
      ? (["JSONRPC", "HTTP+JSON"] as const)
      : []) {
      // biome-ignore lint/performance/noAwaitInLoops: One binding after the other keeps the log readable.
      await sdkCallsUs(deployment, agent, key, binding);
    }
    if (values.part !== "sdk-client") {
      await usCallSdk(deployment, workDir, sdkDir);
    }
  } finally {
    await deployment.stop();
  }
  const failed = results.filter((result) => !result.ok);
  console.log(
    `\nSDK interop (@a2a-js/sdk 1.3.0): ${results.length - failed.length} of ${results.length} checks passed`
  );
  for (const result of failed) {
    console.log(`  FAIL ${result.name}: ${result.detail}`);
  }
  await sleep(0);
  return failed.length === 0 ? 0 : 1;
};

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  );
}
