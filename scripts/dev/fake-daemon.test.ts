import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DaemonHello,
  daemonHelloSchema,
  type EnrollResponse,
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

interface TestServer {
  hellos: DaemonHello[];
  issued: () => string;
  port: number;
  stop: () => void;
}

const startServer = (): TestServer => {
  let issued = "";
  const hellos: DaemonHello[] = [];
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
