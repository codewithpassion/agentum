#!/usr/bin/env bun
// Interop with a real Hermes (https://github.com/NousResearch/hermes-agent) at
// its latest release tag, in both directions, against a real `vite dev`
// Worker. Hermes talks only to a fake OpenAI-compatible model endpoint
// (scripts/e2e/a2a-fake-openai.ts), so it needs no key and costs nothing.
//
//   Hermes calls us. A real Hermes agent loop (`hermes chat`, run by the
//   gateway daemon) is told by the fake model to use its `a2a_discover` and
//   `a2a_call` tools on one of our published agents, with a key:
//     - `auto`: the answer comes back;
//     - `approve`: the waiting message comes back;
//     - pairing: with "Accept pairing requests" on, a call with a made-up token
//       returns a code as its reply, and once the owner enters the code the
//       next call is let through.
//   We call Hermes. A real Hermes gateway with the `a2a` platform serves a
//   card. One of our agents is connected to it through "Call it" and a run of
//   that agent sends it messages with the `send_message` tool:
//     - a plain reply;
//     - a reply that outlasts our client timeout, recovered through ListTasks
//       and GetTask by the minute tick;
//     - a push notification that nudges us to read the full text (past the
//       2000 characters Hermes puts in the push body) with no tick at all.
//
// Hermes is third-party code. The script clones the release tag into its own
// folder under the work folder and installs it there with `uv sync --frozen`
// (uv 0.13 or newer, Python 3.14 final; the work folder keeps everything, the
// repo and `~/.hermes` are never touched). Each Hermes runs with its own
// HERMES_HOME and HOME under the work folder. Run from the repo root:
//
//   bun scripts/e2e/a2a-hermes.ts [--work-dir <dir>] [--hermes-dir <dir>]
//     [--uv <uv>] [--server <origin> --state-dir <dir>]
//
// `--server` uses a deployment that is already running (with its wrangler state
// folder for `--state-dir`) and stops nothing.
//
// Exit code 0 when every check passed. The summary goes into
// docs/reviews/tasks/AA.8.md.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { file, type Subprocess, sleep, spawn } from "bun";
import { startFakeOpenAi } from "./a2a-fake-openai.ts";
import {
  attachDeployment,
  createDeployment,
  type Deployment,
  defaultWorkDir,
  E2eError,
  freePort,
  giveKey,
  type PublishedAgent,
  publishAgent,
  queryRows,
  thirdPartyEnv,
  waitUntil,
} from "./a2a-harness.ts";

const HERMES_REPO = "https://github.com/NousResearch/hermes-agent";
const HERMES_TAG = "v0.22.5";
const HOURLY_LIMIT = 10_000;
/** Our client's timeout for a call to a peer (`PEER_FETCH_TIMEOUT_MS`). */
const CLIENT_TIMEOUT_MS = 15_000;
const LONG_CHARS = 3000;
const PUSH_CUTOFF = 2000;
/**
 * Our first poll of a task whose send timed out comes a minute after the send
 * (`FAST_POLL_MS`), and that poll registers the webhook. Hermes has to still be
 * working then, so its reply takes a minute and a half.
 */
const PUSH_SLOW_MS = 90_000;
const PAIRING_CODE = /Pairing code: ([A-Z2-9]{8})/;
const PID_LINE = /PID: (\d+)/;
const SESSION_LINE = /\n*session_id: .*$/s;

// ---------------------------------------------------------------------------
// Checks, as in a2a-interop.ts

interface Result {
  detail: string;
  name: string;
  ok: boolean;
}
const results: Result[] = [];

const check = async (
  name: string,
  body: () => Promise<string | undefined>
): Promise<boolean> => {
  const started = Date.now();
  try {
    const detail = (await body()) ?? "";
    results.push({ detail, name, ok: true });
    console.log(
      `ok    ${name}${detail ? ` (${detail})` : ""} ${Date.now() - started} ms`
    );
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ detail, name, ok: false });
    console.log(`FAIL  ${name}: ${detail}`);
    return false;
  }
};

const expect = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new E2eError(message);
  }
};

// ---------------------------------------------------------------------------
// Hermes

const run = async (cmd: string[], cwd: string): Promise<void> => {
  const proc = spawn(cmd, {
    cwd,
    env: thirdPartyEnv(),
    stderr: "inherit",
    stdout: "inherit",
  });
  if ((await proc.exited) !== 0) {
    throw new E2eError(`${cmd.join(" ")} failed in ${cwd}`);
  }
};

const ensureHermes = async (dir: string, uv: string): Promise<void> => {
  if (!existsSync(join(dir, "pyproject.toml"))) {
    await run(
      [
        "git",
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--branch",
        HERMES_TAG,
        HERMES_REPO,
        dir,
      ],
      process.cwd()
    );
  }
  const described = spawn(["git", "describe", "--tags", "--exact-match"], {
    cwd: dir,
    env: thirdPartyEnv(),
    stderr: "pipe",
    stdout: "pipe",
  });
  const tag = (await new Response(described.stdout).text()).trim();
  if (tag !== HERMES_TAG) {
    throw new E2eError(
      `${dir} is at "${tag}", not ${HERMES_TAG}. Remove it and run again.`
    );
  }
  if (!existsSync(join(dir, ".venv", "bin", "hermes"))) {
    await run([uv, "sync", "--frozen", "--python", "3.14"], dir);
  }
};

interface HermesHome {
  dir: string;
  env: Record<string, string>;
}

/** A HERMES_HOME of its own, with the fake model and the settings the test needs. */
const makeHome = (
  workDir: string,
  name: string,
  options: { a2aAgents?: string; extra?: string; inboundPort?: number },
  modelUrl: string,
  env: Record<string, string> = {}
): HermesHome => {
  const dir = join(workDir, "hermes-homes", name);
  mkdirSync(join(dir, "home"), { recursive: true });
  const config = [
    "model:",
    "  provider: custom",
    "  default: fake-model",
    `  base_url: ${modelUrl}`,
    "  api_key: fake-key",
    "tools:",
    "  tool_search:",
    '    enabled: "off"',
    ...(options.inboundPort
      ? [
          "gateway:",
          "  platforms:",
          "    a2a:",
          "      enabled: true",
          "      extra:",
          `        port: ${options.inboundPort}`,
        ]
      : []),
    options.a2aAgents ?? "",
    options.extra ?? "",
  ].join("\n");
  writeFileSync(join(dir, "config.yaml"), `${config}\n`);
  return {
    dir,
    env: {
      HERMES_HOME: dir,
      // Nothing under the real home directory is read.
      HOME: join(dir, "home"),
      ...env,
    },
  };
};

const hermesBin = (hermesDir: string): string =>
  join(hermesDir, ".venv", "bin", "hermes");

/** One `hermes chat` turn. The fake model decides what the agent does. */
const chat = async (
  hermesDir: string,
  home: HermesHome,
  modelUrl: string,
  text: string
): Promise<string> => {
  const proc = spawn(
    [
      hermesBin(hermesDir),
      "chat",
      "-Q",
      "-q",
      text,
      "-t",
      "a2a",
      "--provider",
      "custom",
      "--base-url",
      modelUrl,
      "--api-key",
      "fake-key",
      "-m",
      "fake-model",
    ],
    {
      cwd: home.dir,
      env: thirdPartyEnv(home.env),
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const timer = setTimeout(() => proc.kill(), 180_000);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const answer = out.replace(SESSION_LINE, "").trim();
  if (answer === "") {
    throw new E2eError(`hermes chat answered nothing: ${err.slice(0, 300)}`);
  }
  return answer;
};

/** The gateway daemon `hermes chat` starts ends itself when idle, but not before the script does. */
const stopDaemon = async (
  hermesDir: string,
  home: HermesHome
): Promise<void> => {
  const proc = spawn([hermesBin(hermesDir), "gateway", "status"], {
    cwd: home.dir,
    env: thirdPartyEnv(home.env),
    stderr: "pipe",
    stdout: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const pid = PID_LINE.exec(text)?.[1];
  if (pid) {
    try {
      process.kill(Number(pid));
    } catch {
      // It already ended.
    }
  }
};

interface Gateway {
  port: number;
  proc: Subprocess;
  stop: () => Promise<void>;
}

/** `hermes gateway run` with the `a2a` platform on, until `stop`. */
const startGateway = async (
  hermesDir: string,
  home: HermesHome,
  port: number,
  env: Record<string, string>,
  logFile: string
): Promise<Gateway> => {
  const log = file(logFile);
  const proc = spawn([hermesBin(hermesDir), "gateway", "run"], {
    cwd: home.dir,
    detached: true,
    env: thirdPartyEnv({
      ...home.env,
      A2A_AGENT_NAME: `hermes-${port}`,
      A2A_PORT: String(port),
      ...env,
    }),
    stderr: log,
    stdout: log,
  });
  await waitUntil(`the Hermes gateway on ${port}`, 120_000, async () => {
    if (proc.exitCode !== null) {
      throw new E2eError(
        `hermes gateway exited with ${proc.exitCode}. See ${logFile}`
      );
    }
    return await fetch(
      `http://127.0.0.1:${port}/.well-known/agent-card.json`
    ).then(
      (response) => response.ok,
      () => false
    );
  });
  return {
    port,
    proc,
    stop: async () => {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      await Promise.race([proc.exited, sleep(10_000)]);
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Our side

interface OutboundRow {
  result_text: string | null;
  state: string;
}

const lastOutbound = (deployment: Deployment): OutboundRow | undefined =>
  queryRows<OutboundRow>(
    deployment,
    "select state, result_text from a2a_outbound_tasks order by created_at desc limit 1"
  ).at(0);

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
      session: { externalKey: `hermes-${crypto.randomUUID()}`, origin: "ui" },
    }
  );
  let view: RunView = { error: null, resultText: null, status: "queued" };
  await waitUntil("the run ending", 180_000, async () => {
    view = await deployment.person.query<RunView>("runs.get", { runId });
    return ["done", "failed", "cancelled", "interrupted"].includes(view.status);
  });
  return view;
};

const sendTool = (slug: string, text: string, waitMs: number): string =>
  `call harbourmaster_send_message ${JSON.stringify({ agent: slug, text, waitMs })}`;

/** Connects a new agent of ours to a Hermes gateway through "Call it". */
const connectTo = async (
  deployment: Deployment,
  name: string,
  port: number,
  credential: string | undefined
): Promise<{ agentId: string; slug: string }> => {
  const caller = await deployment.person.mutate<{ id: string }>(
    "agents.create",
    {
      instructions: "Call peers when asked.",
      model: "faux",
      name,
      runtime: "cloud",
      slug: `${name.toLowerCase().replaceAll(" ", "-")}-${Date.now()}`,
    }
  );
  const connection = await deployment.person.mutate<{
    id: string;
    slug: string;
  }>("a2a.addOutbound", {
    agentId: caller.id,
    cardUrl: `http://127.0.0.1:${port}/.well-known/agent-card.json`,
    ...(credential ? { credential } : {}),
    label: name,
  });
  await deployment.person.mutate("a2a.setPolicies", {
    connectionId: connection.id,
    outboundPolicy: "auto",
  });
  return {
    agentId: caller.id,
    slug: `${connection.slug}/${name.toLowerCase().replaceAll(" ", "-")}`,
  };
};

// ---------------------------------------------------------------------------
// Hermes calls us

const hermesCallsUs = async (
  deployment: Deployment,
  hermesDir: string,
  workDir: string,
  modelUrl: string
): Promise<void> => {
  const agent: PublishedAgent = await publishAgent(
    deployment.person,
    "Hermes Target"
  );
  const auto = await giveKey(deployment.person, agent, "hermes auto", {
    hourlyLimit: HOURLY_LIMIT,
    inboundPolicy: "auto",
  });
  const approve = await giveKey(deployment.person, agent, "hermes approve");
  await deployment.person.mutate("a2a.setPairingOpen", {
    agentId: agent.agentId,
    open: true,
  });
  const madeUpToken =
    `made-up-${crypto.randomUUID()}-${crypto.randomUUID()}`.replaceAll("-", "");
  // The shape of the block is the one the key dialog shows.
  const peer = (name: string, token: string) =>
    [
      `  ${name}:`,
      `    url: "${deployment.origin}/a2a/${agent.publicId}"`,
      `    auth: { type: bearer, token: "${token}" }`,
      "    timeout: 120",
    ].join("\n");
  const home = makeHome(
    workDir,
    "calls-us",
    {
      a2aAgents: `a2a_agents:\n${[
        peer("hm-auto", auto.token),
        peer("hm-approve", approve.token),
        peer("hm-pairing", madeUpToken),
      ].join("\n")}`,
    },
    modelUrl
  );
  const call = (agentName: string, message: string) =>
    chat(
      hermesDir,
      home,
      modelUrl,
      `CALL a2a_call ${JSON.stringify({ agent: agentName, message })}`
    );
  try {
    await check("hermes -> us: a2a_discover reads the card", async () => {
      const text = await chat(
        hermesDir,
        home,
        modelUrl,
        `CALL a2a_discover ${JSON.stringify({ url: `${deployment.origin}/a2a/${agent.publicId}` })}`
      );
      expect(
        text.includes("Hermes Target"),
        `discover said: ${text.slice(0, 200)}`
      );
      expect(
        text.includes("JSONRPC"),
        "discover did not list the JSON-RPC interface"
      );
      return "name, interfaces and skills read";
    });

    await check(
      "hermes -> us: a2a_call, auto, the answer comes back",
      async () => {
        const text = await call("hm-auto", "say pong");
        expect(
          text.includes("completed"),
          `no completed task: ${text.slice(0, 300)}`
        );
        expect(
          text.includes("pong"),
          `the answer is missing: ${text.slice(0, 300)}`
        );
        return "completed with the agent's answer";
      }
    );

    await check(
      "hermes -> us: a2a_call, approve, the waiting message comes back",
      async () => {
        const text = await call("hm-approve", "say hi");
        expect(
          text.includes("Waiting for a person"),
          `no waiting message: ${text.slice(0, 300)}`
        );
        return "auth-required with the words for Hermes to read";
      }
    );

    let code = "";
    await check(
      "hermes -> us: pairing, a made-up token returns a code as the reply",
      async () => {
        const text = await call("hm-pairing", "say hi");
        const found = PAIRING_CODE.exec(text);
        expect(found?.[1], `no code in the reply: ${text.slice(0, 300)}`);
        code = found?.[1] ?? "";
        expect(
          !text.includes("say hi") || text.includes("Nothing was delivered"),
          "the reply does not say nothing was delivered"
        );
        return "a rejected task whose status message holds the code";
      }
    );

    await check(
      "hermes -> us: pairing, entering the code lets the next call through",
      async () => {
        expect(code, "no code to enter");
        await deployment.person.mutate("a2a.approvePairingCode", {
          agentId: agent.agentId,
          code,
          label: "Hermes (paired)",
        });
        const text = await call("hm-pairing", "say hi");
        expect(
          !PAIRING_CODE.test(text),
          `the call still got a code: ${text.slice(0, 300)}`
        );
        expect(
          text.includes("Waiting for a person"),
          `the paired call was not let through to the default policy: ${text.slice(0, 300)}`
        );
        return "let through, and held for approval by the default policy";
      }
    );
  } finally {
    await stopDaemon(hermesDir, home);
  }
};

// ---------------------------------------------------------------------------
// We call Hermes

const weCallHermes = async (
  deployment: Deployment,
  hermesDir: string,
  workDir: string,
  modelUrl: string
): Promise<void> => {
  const token = `hm-${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const tokenPort = await freePort();
  const tokenHome = makeHome(
    workDir,
    "called-with-token",
    { inboundPort: tokenPort },
    modelUrl
  );
  let tokenGateway: Gateway | undefined;
  try {
    tokenGateway = await startGateway(
      hermesDir,
      tokenHome,
      tokenPort,
      {
        A2A_PEER_TOKENS: `agentum:${token}`,
        A2A_PUBLIC_URL: `http://127.0.0.1:${tokenPort}`,
        A2A_TRUSTED_PEERS: "agentum",
      },
      join(workDir, "hermes-gateway-token.log")
    );
    const caller = await connectTo(
      deployment,
      "Hermes Token",
      tokenPort,
      token
    );

    await check(
      "us -> hermes: Call it reads the card and a message gets a reply",
      async () => {
        const view = await runAgent(
          deployment,
          caller.agentId,
          sendTool(caller.slug, "say hello", 25_000)
        );
        expect(
          view.status === "done",
          `run ended ${view.status}: ${view.error}`
        );
        expect(
          view.resultText?.includes("echo:"),
          `no reply from Hermes: ${view.resultText?.slice(0, 300)}`
        );
        return "Hermes's agent answered through the connection";
      }
    );

    await check(
      "us -> hermes: a reply past our client timeout is recovered with ListTasks and GetTask",
      async () => {
        const before = Date.now();
        const view = await runAgent(
          deployment,
          caller.agentId,
          sendTool(
            caller.slug,
            `[[SLOW ${CLIENT_TIMEOUT_MS + 12_000}]] [[LONG ${LONG_CHARS}]] answer slowly`,
            1000
          )
        );
        expect(
          view.status === "done",
          `run ended ${view.status}: ${view.error}`
        );
        let row = lastOutbound(deployment);
        expect(row, "no outbound task row");
        // The tick polls the peer: ListTasks by our context, then GetTask.
        await waitUntil(
          "the recovered reply",
          150_000,
          async () => {
            await deployment.tick();
            row = lastOutbound(deployment);
            return row?.state === "TASK_STATE_COMPLETED";
          },
          3000
        );
        const text = row?.result_text ?? "";
        expect(
          text.length >= LONG_CHARS && text.includes("[END]"),
          `the recovered text is ${text.length} characters and ends "${text.slice(-30)}"`
        );
        return `${text.length} characters, after ${Math.round((Date.now() - before) / 1000)} s`;
      }
    );
  } finally {
    await tokenGateway?.stop();
  }

  // Hermes refuses a push to a loopback address unless it runs with no token
  // at all (its SSRF guard), so the push check uses a second gateway without
  // one. Its calls are open to localhost, which is all this machine is.
  const openPort = await freePort();
  const openHome = makeHome(
    workDir,
    "called-open",
    { inboundPort: openPort },
    modelUrl
  );
  let openGateway: Gateway | undefined;
  try {
    openGateway = await startGateway(
      hermesDir,
      openHome,
      openPort,
      {},
      join(workDir, "hermes-gateway-open.log")
    );
    const caller = await connectTo(
      deployment,
      "Hermes Open",
      openPort,
      undefined
    );
    await check(
      "us -> hermes: a push nudges us to read the full text, with no tick",
      async () => {
        const view = await runAgent(
          deployment,
          caller.agentId,
          sendTool(
            caller.slug,
            `[[SLOW ${PUSH_SLOW_MS}]] [[LONG ${LONG_CHARS}]] answer by push`,
            1000
          )
        );
        expect(
          view.status === "done",
          `run ended ${view.status}: ${view.error}`
        );
        // One tick: it finds the task by our context and registers the webhook.
        // Nothing polls after that, so the full text can only come from the push.
        await waitUntil(
          "the task to be found",
          120_000,
          async () => {
            await deployment.tick();
            const found = lastOutbound(deployment);
            return (
              found !== undefined && found.state !== "TASK_STATE_SUBMITTED"
            );
          },
          2000
        );
        const registered = lastOutbound(deployment);
        expect(
          registered?.state !== "TASK_STATE_COMPLETED",
          "the task finished before the webhook could be registered"
        );
        await waitUntil(
          "the push",
          120_000,
          () => {
            const row = lastOutbound(deployment);
            return row?.state === "TASK_STATE_COMPLETED";
          },
          1000
        );
        const text = lastOutbound(deployment)?.result_text ?? "";
        expect(
          text.length > PUSH_CUTOFF && text.includes("[END]"),
          `the text is ${text.length} characters and ends "${text.slice(-30)}"`
        );
        return `${text.length} characters, more than the ${PUSH_CUTOFF} in Hermes's push body`;
      }
    );
  } finally {
    await openGateway?.stop();
  }
};

// ---------------------------------------------------------------------------

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    options: {
      "hermes-dir": { type: "string" },
      server: { type: "string" },
      "state-dir": { type: "string" },
      uv: { default: "uv", type: "string" },
      "work-dir": { type: "string" },
    },
  });
  const workDir = values["work-dir"] ?? defaultWorkDir();
  const hermesDir = values["hermes-dir"] ?? join(workDir, "hermes-agent");
  mkdirSync(workDir, { recursive: true });
  await ensureHermes(hermesDir, values.uv);
  const fake = startFakeOpenAi(await freePort());
  const deployment = values.server
    ? attachDeployment(values.server, values["state-dir"])
    : createDeployment({ name: "hermes", port: await freePort(), workDir });
  try {
    await deployment.start();
    await hermesCallsUs(deployment, hermesDir, workDir, fake.url);
    if (deployment.stateDir === "") {
      throw new E2eError(
        "--server cannot read the database for the second half; start the script without it"
      );
    }
    await weCallHermes(deployment, hermesDir, workDir, fake.url);
  } finally {
    fake.stop();
    await deployment.stop();
  }
  const failed = results.filter((result) => !result.ok);
  console.log(
    `\nHermes interop (${HERMES_TAG}): ${results.length - failed.length} of ${results.length} checks passed`
  );
  for (const result of failed) {
    console.log(`  FAIL ${result.name}: ${result.detail}`);
  }
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
