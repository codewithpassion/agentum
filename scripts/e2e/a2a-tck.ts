#!/usr/bin/env bun
// Runs the official A2A TCK (https://github.com/a2aproject/a2a-tck) against a
// local `vite dev` deployment, on both bindings the agent card declares
// (JSON-RPC and HTTP+JSON). The TCK checkout is third-party code: it lives in
// its own folder under the work folder, never in this repo.
//
//   bun scripts/e2e/a2a-tck.ts [--work-dir <dir>] [--tck-dir <dir>]
//     [--level must|should|may] [--transport jsonrpc,http_json]
//
// The TCK's clients send no Authorization header, so a proxy adds the key of
// an access key connection (scripts/e2e/a2a-tck-proxy.ts). That connection
// takes messages without approval and has a high hourly limit, because the
// suite sends far more than 20 tasks.
//
// First time: the script clones the TCK at `main` and installs it into a venv
// in its folder (needs git, uv and Python 3.11 or newer). Reports go to
// `<work-dir>/tck-reports/<level>-<time>/`. The exit code is the TCK's.
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { spawn } from "bun";
import {
  createDeployment,
  defaultWorkDir,
  E2eError,
  freePort,
  giveKey,
  publishAgent,
  rpc,
  sleep,
  thirdPartyEnv,
} from "./a2a-harness.ts";
import { promptForMessageId } from "./a2a-tck-prompts.ts";
import { startTckProxy } from "./a2a-tck-proxy.ts";

const TCK_REPO = "https://github.com/a2aproject/a2a-tck";
/** `main` of the TCK on 22 October 2026. The repo has no release after 1.0.0.alpha3. */
const TCK_COMMIT = "d4d6fae7887f88ef607fb461c13e3b0e1802f19b";
const HOURLY_LIMIT = 10_000;

const REAP_AFTER_MS = 6000;
const REAP_EVERY_MS = 2000;

interface ListedTask {
  id: string;
  status: { state: string; timestamp?: string };
}

/**
 * An agent runs one run at a time, and a task waiting for input keeps its run.
 * The TCK leaves many such tasks behind, so every later send would queue behind
 * them. While a send has been queued for a few seconds, the reaper cancels the
 * tasks waiting for input, as a person would. It never touches a working task.
 * Returns how many it cancelled.
 */
const startReaper = (origin: string, publicId: string, token: string) => {
  let stopped = false;
  let cancelled = 0;
  const loop = (async () => {
    while (!stopped) {
      // biome-ignore lint/performance/noAwaitInLoops: A timer loop.
      await sleep(REAP_EVERY_MS);
      try {
        const listed = await rpc(origin, publicId, token, "ListTasks", {
          pageSize: 100,
        });
        const result = listed.body.result as
          | { tasks?: ListedTask[] }
          | undefined;
        const tasks = result?.tasks ?? [];
        const age = (task: ListedTask) =>
          Date.now() - Date.parse(task.status.timestamp ?? "");
        const queued = tasks.some(
          (task) =>
            task.status.state === "TASK_STATE_SUBMITTED" &&
            age(task) > REAP_AFTER_MS
        );
        if (!queued) {
          continue;
        }
        for (const task of tasks) {
          if (task.status.state === "TASK_STATE_INPUT_REQUIRED") {
            // biome-ignore lint/performance/noAwaitInLoops: One cancel after the other.
            await rpc(origin, publicId, token, "CancelTask", { id: task.id });
            cancelled += 1;
          }
        }
      } catch {
        // The next round tries again.
      }
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      await loop;
      return cancelled;
    },
  };
};

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

/** Clones and installs the TCK when its folder is not there yet. */
const ensureTck = async (dir: string): Promise<void> => {
  if (existsSync(join(dir, ".venv", "bin", "run-tck"))) {
    return;
  }
  if (!existsSync(join(dir, "run_tck.py"))) {
    await run(["git", "clone", "--quiet", TCK_REPO, dir], process.cwd());
    await run(["git", "checkout", "--quiet", TCK_COMMIT], dir);
  }
  await run(["uv", "venv", "--quiet", ".venv"], dir);
  await run(["uv", "pip", "install", "--quiet", "-e", "."], dir);
};

export interface TckSummary {
  failed: { id: string; level: string; transports: string[] }[];
  /** Requirements the suite has no test for on this server (card signing, scopes and others). */
  notTested: number;
  passed: number;
  /** Requirements whose tests skipped (gRPC, an optional capability the card does not declare). */
  skipped: number;
  total: number;
}

interface PerRequirement {
  level?: string;
  status?: string;
  transports?: Record<string, string>;
}

/** The pass, fail and skip counts of a TCK `compatibility.json`, by requirement. */
export const summarise = (report: unknown): TckSummary => {
  const root = report as { per_requirement?: Record<string, PerRequirement> };
  const summary: TckSummary = {
    failed: [],
    notTested: 0,
    passed: 0,
    skipped: 0,
    total: 0,
  };
  for (const [id, requirement] of Object.entries(root.per_requirement ?? {})) {
    summary.total += 1;
    if (requirement.status === "PASS") {
      summary.passed += 1;
    } else if (requirement.status === "FAIL") {
      summary.failed.push({
        id,
        level: requirement.level ?? "?",
        transports: Object.entries(requirement.transports ?? {})
          .filter(([, status]) => status === "FAIL")
          .map(([transport]) => transport),
      });
    } else if (requirement.status === "SKIPPED") {
      summary.skipped += 1;
    } else {
      summary.notTested += 1;
    }
  }
  return summary;
};

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    options: {
      level: { type: "string" },
      "tck-dir": { type: "string" },
      transport: { default: "jsonrpc,http_json", type: "string" },
      "work-dir": { type: "string" },
    },
  });
  const workDir = values["work-dir"] ?? defaultWorkDir();
  const tckDir = values["tck-dir"] ?? join(workDir, "a2a-tck");
  mkdirSync(workDir, { recursive: true });
  await ensureTck(tckDir);

  const deployment = createDeployment({
    name: "tck",
    port: await freePort(),
    workDir,
  });
  let proxy: ReturnType<typeof startTckProxy> | undefined;
  try {
    await deployment.start();
    const agent = await publishAgent(deployment.person, "TCK Agent");
    const key = await giveKey(deployment.person, agent, "a2a-tck", {
      hourlyLimit: HOURLY_LIMIT,
      inboundPolicy: "auto",
    });
    proxy = startTckProxy({
      port: await freePort(),
      promptFor: promptForMessageId,
      publicId: agent.publicId,
      token: key.token,
      upstream: deployment.origin,
    });
    const reaper = startReaper(deployment.origin, agent.publicId, key.token);
    const args = [
      join(tckDir, ".venv", "bin", "python"),
      "run_tck.py",
      `--sut-host=${proxy.host}/a2a/${agent.publicId}`,
      `--transport=${values.transport}`,
      ...(values.level ? [`--level=${values.level}`] : []),
      "-v",
    ];
    console.log(`TCK against ${proxy.host} -> ${deployment.origin}`);
    const tck = spawn(args, {
      cwd: tckDir,
      env: thirdPartyEnv(),
      stderr: "inherit",
      stdout: "inherit",
    });
    const code = await tck.exited;
    const reaped = await reaper.stop();
    const out = join(
      workDir,
      "tck-reports",
      `${values.level ?? "all"}-${new Date().toISOString().replaceAll(":", "")}`
    );
    mkdirSync(out, { recursive: true });
    cpSync(join(tckDir, "reports"), out, { recursive: true });
    const summary = summarise(
      JSON.parse(readFileSync(join(out, "compatibility.json"), "utf8"))
    );
    console.log(
      `TCK: ${summary.passed} requirements passed, ${summary.failed.length} failed, ${summary.skipped} skipped, ${summary.notTested} not tested, of ${summary.total}. Reports in ${out}`
    );
    for (const failure of summary.failed) {
      console.log(
        `  FAIL ${failure.id} (${failure.level}, ${failure.transports.join(", ")})`
      );
    }
    console.log(
      `The harness cancelled ${reaped} task(s) left waiting for input, so queued sends could start.`
    );
    return code;
  } finally {
    proxy?.stop();
    await deployment.stop();
  }
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
