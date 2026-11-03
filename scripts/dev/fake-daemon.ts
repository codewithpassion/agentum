#!/usr/bin/env bun
// Stands in for the Agentum machine daemon so the Worker can be tested by
// hand. With `--code` it enrolls and stores the credential in a state file. It
// then opens one relay connection and prints every frame it receives as a JSON
// line on stdout. Errors go to stderr. Run from the repo root. With `--echo` it
// also claims each offered run and finishes it with an echo of the input text.
import { existsSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  CLOSE_CODES,
  type CompleteRequest,
  claimResponseSchema,
  type DaemonHello,
  type DaemonPing,
  type EventsRequest,
  enrollResponseSchema,
  HEARTBEAT_SECONDS,
  relayFrameSchema,
} from "@repo/protocol/machine";

const DEFAULT_SERVER = "http://localhost:3000";
const DEFAULT_STATE_FILE = ".fake-daemon.json";
const DAEMON_VERSION = "fake-0.0.0";
const TRAILING_SLASHES = /\/+$/;
const HTTP_PREFIX = /^http/;

const hello: DaemonHello = {
  agents: [],
  capabilities: { agentSdk: "fake", container: false },
  daemonVersion: DAEMON_VERSION,
  type: "hello",
};

type Output = (text: string) => void;

export interface FakeDaemonOptions {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  err: Output;
  out: Output;
}

interface StoredState {
  credential: string;
  machineId: string;
  server: string;
}

class FakeDaemonError extends Error {}

const parseCli = (argv: string[]) =>
  parseArgs({
    allowPositionals: false,
    args: argv,
    options: {
      code: { type: "string" },
      echo: { type: "boolean" },
      server: { type: "string" },
      "single-user": { type: "boolean" },
      state: { type: "string" },
    },
    strict: true,
  }).values;

const isStoredState = (value: unknown): value is StoredState =>
  typeof value === "object" &&
  value !== null &&
  "server" in value &&
  typeof value.server === "string" &&
  "machineId" in value &&
  typeof value.machineId === "string" &&
  "credential" in value &&
  typeof value.credential === "string";

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const readState = async (path: string): Promise<StoredState> => {
  if (!existsSync(path)) {
    throw new FakeDaemonError(
      `No state file at ${path}. Enroll with --code hm_enr_... first.`
    );
  }
  const value = parseJson(await readFile(path, "utf8"));
  if (!isStoredState(value)) {
    throw new FakeDaemonError(`State file ${path} is not a daemon state file.`);
  }
  return value;
};

const enroll = async ({
  code,
  path,
  server,
  singleUser,
  out,
}: {
  code: string;
  path: string;
  server: string;
  singleUser: boolean;
  out: Output;
}): Promise<StoredState> => {
  const response = await fetch(
    `${server.replace(TRAILING_SLASHES, "")}/api/machines/enroll`,
    {
      body: JSON.stringify({ code, singleUser }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }
  );
  if (!response.ok) {
    const body = await response.text();
    throw new FakeDaemonError(`enroll failed: ${response.status}\n${body}`);
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = enrollResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new FakeDaemonError("enroll answer does not match the protocol.");
  }
  const state: StoredState = {
    credential: parsed.data.credential,
    machineId: parsed.data.machineId,
    server,
  };
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600);
  out(`enrolled ${state.machineId}\n`);
  return state;
};

interface RunTarget {
  credential: string;
  err: Output;
  out: Output;
  server: string;
}

const postRun = (
  credential: string,
  url: string,
  body?: EventsRequest | CompleteRequest
) =>
  fetch(url, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      authorization: `Bearer ${credential}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    method: "POST",
  });

const echoRun = async (
  { credential, err, out, server }: RunTarget,
  runId: string
): Promise<void> => {
  const runUrl = (action: string) =>
    `${server.replace(TRAILING_SLASHES, "")}/api/machines/runs/${runId}/${action}`;
  const claim = await postRun(credential, runUrl("claim"));
  if (!claim.ok) {
    err(`claim ${runId} failed: ${claim.status}\n`);
    return;
  }
  const parsed = claimResponseSchema.safeParse(
    await claim.json().catch(() => undefined)
  );
  if (!parsed.success) {
    err(`claim ${runId} answer does not match the protocol.\n`);
    return;
  }
  out(`claimed ${runId}\n`);
  const text = `Echo: ${parsed.data.run.inputText}`;
  const events: EventsRequest = {
    events: [{ payload: { text }, seq: 1, type: "message.assistant" }],
  };
  const eventsResponse = await postRun(credential, runUrl("events"), events);
  if (!eventsResponse.ok) {
    err(`events ${runId} failed: ${eventsResponse.status}\n`);
    return;
  }
  const complete: CompleteRequest = { status: "done", text };
  const completeResponse = await postRun(
    credential,
    runUrl("complete"),
    complete
  );
  if (!completeResponse.ok) {
    err(`complete ${runId} failed: ${completeResponse.status}\n`);
    return;
  }
  out(`completed ${runId}\n`);
};

const connect = ({
  credential,
  echo,
  server,
  out,
  err,
}: StoredState & {
  echo: boolean;
  out: Output;
  err: Output;
}): Promise<number> =>
  new Promise((resolveExit) => {
    const base = server
      .replace(TRAILING_SLASHES, "")
      .replace(HTTP_PREFIX, "ws");
    const url = `${base}/api/machines/connect`;
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    let stopping = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    // Offers are echoed one after another, so each waits for the previous one.
    let echoing: Promise<void> = Promise.resolve();

    const stop = () => {
      stopping = true;
      socket.close(1000, "daemon stopped");
    };
    const finish = (code: number) => {
      clearInterval(heartbeat);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolveExit(code);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(hello));
      heartbeat = setInterval(() => {
        const ping: DaemonPing = { at: new Date().toISOString(), type: "ping" };
        socket.send(JSON.stringify(ping));
      }, HEARTBEAT_SECONDS * 1000);
    });

    socket.addEventListener("message", (event) => {
      const text = String(event.data);
      const frame = relayFrameSchema.safeParse(parseJson(text));
      if (frame.success) {
        out(`${JSON.stringify(frame.data)}\n`);
        if (echo && frame.data.type === "offer") {
          const { runId } = frame.data;
          echoing = echoing
            .then(() => echoRun({ credential, err, out, server }, runId))
            .catch((error: unknown) => {
              const message =
                error instanceof Error ? error.message : String(error);
              err(`offer ${runId} failed: ${message}\n`);
            });
        }
      } else {
        err(`unparseable message: ${text}\n`);
      }
    });

    socket.addEventListener("error", () => {
      err("socket error, waiting for close\n");
    });

    socket.addEventListener("close", (event) => {
      // Let echoes that are still running finish before the daemon exits.
      echoing.then(() => {
        out(`closed ${event.code} ${event.reason}\n`);
        if (stopping) {
          finish(0);
        } else if (event.code === CLOSE_CODES.credentialRejected) {
          err("credential rejected, stopping\n");
          finish(1);
        } else {
          if (event.code === CLOSE_CODES.replaced) {
            out("replaced by a newer connection\n");
          }
          finish(0);
        }
      });
    });
  });

/** Runs the daemon once. Resolves with the exit code when the socket closes. */
export const runFakeDaemon = async ({
  argv,
  cwd,
  env,
  err,
  out,
}: FakeDaemonOptions): Promise<number> => {
  try {
    const flags = parseCli(argv);
    const statePath = resolve(cwd, flags.state ?? DEFAULT_STATE_FILE);
    let state: StoredState;
    if (flags.code === undefined) {
      const stored = await readState(statePath);
      state = { ...stored, server: flags.server ?? stored.server };
    } else {
      state = await enroll({
        code: flags.code,
        out,
        path: statePath,
        server: flags.server ?? env.HM_SERVER ?? DEFAULT_SERVER,
        singleUser: flags["single-user"] === true,
      });
    }
    return await connect({ ...state, echo: flags.echo === true, err, out });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    err(`${message}\n`);
    return 1;
  }
};

if (import.meta.main) {
  process.exitCode = await runFakeDaemon({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    err: (text) => process.stderr.write(text),
    out: (text) => process.stdout.write(text),
  });
}
