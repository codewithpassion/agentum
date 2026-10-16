import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClaimResponse,
  type CompleteRequest,
  type DaemonHello,
  daemonHelloSchema,
  type EnrollResponse,
  type EventsRequest,
  enrollRequestSchema,
  type Offer,
  type RelayHelloAck,
} from "@repo/protocol/machine";
import { serve } from "bun";
import { runFakeDaemon } from "./fake-daemon";

const CODE = "hm_enr_8Hq2LxT5nVw0RcYb3Ks7MdPe";
const MACHINE_ID = "01HZX8K2M4N6P8Q0R2S4T6V8W0";
const AGENT_ID = "01HZX9B6C8D0E2F4G6H8J0K2M4";
const RUN_ID = "01HZXA3N5P7Q9R1S3T5V7W9X1Y";
const SESSION_ID = "01HZXB4P6R8T0V2W4X6Y8Z0A2C";
const INPUT_TEXT = "hello there";

const CLAIM: ClaimResponse = {
  agent: {
    id: AGENT_ID,
    model: "claude-sonnet-4-5",
    name: "Echo",
    runtimeConfig: {},
    slug: "echo",
  },
  inputFileIds: [],
  instructions: "",
  mcpServers: {},
  run: {
    agentId: AGENT_ID,
    id: RUN_ID,
    inputText: INPUT_TEXT,
    sessionId: SESSION_ID,
    workspaceId: "01HZX8A1B2C3D4E5F6G7H8J9K0",
  },
  runToken: "hm_run_3Jk8PqWz2NtR5vYb7Lm4Xs9D",
  session: { id: SESSION_ID, runtimeMachineId: null, runtimeRef: null },
};

interface RunCall {
  authorization: string | null;
  body: unknown;
  method: string;
  path: string;
}

interface StartOptions {
  claimStatus?: number;
}

interface TestServer {
  hellos: DaemonHello[];
  issued: () => string;
  port: number;
  runCalls: RunCall[];
  stop: () => void;
}

const RUN_ROUTE = /^\/api\/machines\/runs\/[^/]+\/(claim|events|complete)$/;

const startServer = ({ claimStatus = 200 }: StartOptions = {}): TestServer => {
  let issued = "";
  const hellos: DaemonHello[] = [];
  const runCalls: RunCall[] = [];

  const answerRun = async (request: Request, path: string) => {
    const text = await request.text();
    runCalls.push({
      authorization: request.headers.get("authorization"),
      body: text === "" ? undefined : JSON.parse(text),
      method: request.method,
      path,
    });
    if (path.endsWith("/claim")) {
      return claimStatus === 200
        ? Response.json(CLAIM)
        : new Response("claimed by another", { status: claimStatus });
    }
    return path.endsWith("/events")
      ? Response.json({ lastSeq: 1 })
      : Response.json({});
  };

  const httpServer = serve<{ accepted: boolean }>({
    fetch: async (request, upgrader) => {
      const url = new URL(request.url);
      if (
        request.method === "POST" &&
        url.pathname === "/api/machines/enroll"
      ) {
        const parsed = enrollRequestSchema.safeParse(await request.json());
        if (!parsed.success) {
          return new Response("bad enroll request", { status: 400 });
        }
        issued = `hm_mach_${crypto.randomUUID().replaceAll("-", "")}`;
        const answer: EnrollResponse = {
          credential: issued,
          machineId: MACHINE_ID,
        };
        return Response.json(answer);
      }
      if (request.method === "POST" && RUN_ROUTE.test(url.pathname)) {
        return answerRun(request, url.pathname);
      }
      if (url.pathname === "/api/machines/connect") {
        const accepted =
          request.headers.get("authorization") === `Bearer ${issued}`;
        if (upgrader.upgrade(request, { data: { accepted } })) {
          return;
        }
        return new Response("expected a websocket", { status: 426 });
      }
      return new Response("not found", { status: 404 });
    },
    hostname: "127.0.0.1",
    port: 0,
    websocket: {
      message: (ws, message) => {
        const parsed = daemonHelloSchema.safeParse(JSON.parse(String(message)));
        if (!parsed.success) {
          ws.close(1008, "bad hello");
          return;
        }
        hellos.push(parsed.data);
        const helloAck: RelayHelloAck = {
          machineId: MACHINE_ID,
          serverTime: "2026-10-16T09:30:00.250Z",
          type: "hello_ack",
        };
        const offer: Offer = {
          agentId: AGENT_ID,
          runId: RUN_ID,
          type: "offer",
        };
        ws.send(JSON.stringify(helloAck));
        ws.send(JSON.stringify(offer));
        ws.close(1012, "replaced");
      },
      open: (ws) => {
        if (!ws.data.accepted) {
          ws.close(4401, "credential rejected");
        }
      },
    },
  });
  return {
    hellos,
    issued: () => issued,
    port: httpServer.port ?? 0,
    runCalls,
    stop: () => httpServer.stop(true),
  };
};

const parseFrames = (stdout: string) =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));

let server: TestServer;
let dir: string;
let serverUrl: string;

beforeEach(async () => {
  server = startServer();
  serverUrl = `http://127.0.0.1:${server.port}`;
  dir = await mkdtemp(join(tmpdir(), "fake-daemon-"));
});

afterEach(async () => {
  server.stop();
  await rm(dir, { force: true, recursive: true });
});

const runCli = async (argv: string[]) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runFakeDaemon({
    argv,
    cwd: dir,
    env: {},
    err: (text) => stderr.push(text),
    out: (text) => stdout.push(text),
  });
  return { code, stderr: stderr.join(""), stdout: stdout.join("") };
};

const enrollArgs = (statePath: string) => [
  "--code",
  CODE,
  "--server",
  serverUrl,
  "--state",
  statePath,
];

test("enrolling stores the credential and connects", async () => {
  const statePath = join(dir, "state.json");

  const result = await runCli(enrollArgs(statePath));

  expect(result.code).toBe(0);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  expect(state).toEqual({
    credential: server.issued(),
    machineId: MACHINE_ID,
    server: serverUrl,
  });
  expect((await stat(statePath)).mode.toString(8).slice(-3)).toBe("600");
  expect(result.stdout).toContain(`enrolled ${MACHINE_ID}\n`);
  expect(result.stdout).toContain("replaced by a newer connection\n");
  expect(result.stdout).toContain("closed 1012 replaced\n");
  expect(parseFrames(result.stdout)).toEqual([
    {
      machineId: MACHINE_ID,
      serverTime: "2026-10-16T09:30:00.250Z",
      type: "hello_ack",
    },
    { agentId: AGENT_ID, runId: RUN_ID, type: "offer" },
  ]);
  expect(server.hellos).toHaveLength(1);
});

test("a run without --code reuses the stored credential", async () => {
  const statePath = join(dir, "state.json");
  await runCli(enrollArgs(statePath));

  const result = await runCli(["--state", statePath]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("closed 1012 replaced\n");
  expect(server.hellos).toHaveLength(2);
});

test("a rejected credential exits with code 1 after the 4401 close", async () => {
  const statePath = join(dir, "state.json");
  await writeFile(
    statePath,
    JSON.stringify({
      credential: "hm_mach_not_issued",
      machineId: MACHINE_ID,
      server: serverUrl,
    })
  );

  const result = await runCli(["--state", statePath]);

  expect(result.code).toBe(1);
  expect(result.stdout).toContain("closed 4401 credential rejected\n");
  expect(result.stderr).toContain("credential rejected, stopping");
  expect(server.hellos).toHaveLength(0);
});

const RUN_PATH = `/api/machines/runs/${RUN_ID}`;

test("with --echo an offer is claimed, answered and completed with the bearer credential", async () => {
  const statePath = join(dir, "state.json");

  const result = await runCli([...enrollArgs(statePath), "--echo"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain(`claimed ${RUN_ID}\n`);
  expect(result.stdout).toContain(`completed ${RUN_ID}\n`);
  const authorization = `Bearer ${server.issued()}`;
  expect(server.runCalls).toEqual([
    {
      authorization,
      body: undefined,
      method: "POST",
      path: `${RUN_PATH}/claim`,
    },
    {
      authorization,
      body: {
        events: [
          {
            payload: { text: `Echo: ${INPUT_TEXT}` },
            seq: 1,
            type: "message.assistant",
          } satisfies EventsRequest["events"][number],
        ],
      },
      method: "POST",
      path: `${RUN_PATH}/events`,
    },
    {
      authorization,
      body: {
        status: "done",
        text: `Echo: ${INPUT_TEXT}`,
      } satisfies CompleteRequest,
      method: "POST",
      path: `${RUN_PATH}/complete`,
    },
  ]);
});

test("a 409 on claim makes no events or complete calls and the daemon keeps running", async () => {
  server.stop();
  server = startServer({ claimStatus: 409 });
  serverUrl = `http://127.0.0.1:${server.port}`;
  const statePath = join(dir, "state.json");

  const result = await runCli([...enrollArgs(statePath), "--echo"]);

  expect(result.code).toBe(0);
  expect(result.stderr).toContain(`claim ${RUN_ID} failed: 409\n`);
  expect(result.stdout).not.toContain(`claimed ${RUN_ID}`);
  expect(server.runCalls.map((call) => call.path)).toEqual([
    `${RUN_PATH}/claim`,
  ]);
  expect(result.stdout).toContain("closed 1012 replaced\n");
  expect(parseFrames(result.stdout)).toContainEqual({
    agentId: AGENT_ID,
    runId: RUN_ID,
    type: "offer",
  });
});

test("without --echo an offer makes no run calls", async () => {
  const statePath = join(dir, "state.json");

  const result = await runCli(enrollArgs(statePath));

  expect(result.code).toBe(0);
  expect(server.runCalls).toEqual([]);
});
