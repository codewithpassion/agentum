import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "bun";
import { dynamicWorkerSandbox } from "../src/server/skill-scripts/dynamic-worker-sandbox.ts";
import { localWorkerLoader } from "../src/server/skill-scripts/local-worker-loader.ts";
import type { SandboxFile } from "../src/server/skill-scripts/sandbox-port.ts";

const SKILL_DIR = join(import.meta.dir, "investigator-report");
const INCIDENT = "inc_01HZX3Y5N7Q9R2T4V6W8A0B1C2";
const RUN_ID = "run_test_1";
const FILES = ["scripts/lib.ts", "scripts/report.ts", "scripts/step.ts"];

const encoder = new TextEncoder();

const files = (): SandboxFile[] =>
  FILES.map((path) => ({
    bytes: encoder.encode(readFileSync(join(SKILL_DIR, path), "utf8")),
    path,
  }));

const report = JSON.stringify({
  incidentId: INCIDENT,
  outcome: "escalate",
  steps: ["checked the job", "could not reach the database"],
  summary: "The job is stuck and I cannot fix it.",
});

const step = JSON.stringify({
  incidentId: INCIDENT,
  text: "Checked the job.\nIt is stuck.",
});

let helper: ReturnType<typeof localWorkerLoader>;
let server: ReturnType<typeof serve>;
let received: { auth: string | null; body: unknown; path: string }[];
let status: number;

beforeEach(() => {
  helper = localWorkerLoader();
  received = [];
  status = 202;
  server = serve({
    fetch: async (request) => {
      received.push({
        auth: request.headers.get("authorization"),
        body: await request.json(),
        path: new URL(request.url).pathname,
      });
      return new Response(status === 202 ? "{}" : "nope", { status });
    },
    port: 0,
  });
});

afterEach(() => {
  helper.restore();
  server.stop(true);
});

const NAMES = ["CONTROL_PLANE_URL", "HM_RUN_ID"];

/**
 * The real sandbox (workerd) fills `process.env` from the run's `env`. The
 * local loader runs in this process and does not, so the test sets the two
 * variables itself and puts them back afterwards.
 */
const run = async (
  entry: string,
  args: string[],
  env: Record<string, string>
) => {
  const before = NAMES.map((name) => [name, process.env[name]] as const);
  for (const name of NAMES) {
    delete process.env[name];
  }
  Object.assign(process.env, env);
  try {
    return await dynamicWorkerSandbox(helper.loader).run({
      args,
      entry,
      env,
      files: files(),
      maxOutputBytes: 65_536,
      skill: "investigator-report",
      timeoutMs: 10_000,
    });
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
};

describe("investigator-report/scripts/report.ts in the skill sandbox", () => {
  test("posts one investigation.result with the run id from HM_RUN_ID and no Authorization header", async () => {
    const result = await run("scripts/report.ts", [report], {
      CONTROL_PLANE_URL: `http://127.0.0.1:${server.port}/`,
      HM_RUN_ID: RUN_ID,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`reported escalate for ${INCIDENT}`);
    expect(received).toHaveLength(1);
    expect(received[0]?.path).toBe("/ingest/events");
    expect(received[0]?.auth).toBeNull();
    expect(received[0]?.body).toMatchObject({
      actor: { id: "harbourmaster-investigator", kind: "agent" },
      correlation_id: INCIDENT,
      payload: {
        incidentId: INCIDENT,
        outcome: "escalate",
        runId: RUN_ID,
        steps: ["checked the job", "could not reach the database"],
      },
      source: "agent",
      type: "investigation.result",
    });
  });

  test("exits 1 with a report failed line when control-plane refuses", async () => {
    status = 500;
    const result = await run("scripts/report.ts", [report], {
      CONTROL_PLANE_URL: `http://127.0.0.1:${server.port}`,
      HM_RUN_ID: RUN_ID,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("report failed: ");
    expect(result.stdout).toContain("500");
  });

  test("exits 1 without posting when the argument is missing or CONTROL_PLANE_URL is unset", async () => {
    const noArg = await run("scripts/report.ts", [], {
      CONTROL_PLANE_URL: `http://127.0.0.1:${server.port}`,
    });
    const noUrl = await run("scripts/report.ts", [report], {
      HM_RUN_ID: RUN_ID,
    });

    expect(noArg.exitCode).toBe(1);
    expect(noArg.stdout).toContain("report failed: ");
    expect(noUrl.exitCode).toBe(1);
    expect(noUrl.stdout).toContain("CONTROL_PLANE_URL");
    expect(received).toEqual([]);
  });
});

describe("investigator-report/scripts/step.ts in the skill sandbox", () => {
  test("posts one investigation.step with the run id from HM_RUN_ID and no Authorization header", async () => {
    const result = await run("scripts/step.ts", [step], {
      CONTROL_PLANE_URL: `http://127.0.0.1:${server.port}/`,
      HM_RUN_ID: RUN_ID,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`step posted for ${INCIDENT}`);
    expect(received).toHaveLength(1);
    expect(received[0]?.path).toBe("/ingest/events");
    expect(received[0]?.auth).toBeNull();
    expect(received[0]?.body).toMatchObject({
      actor: { id: "harbourmaster-investigator", kind: "agent" },
      correlation_id: INCIDENT,
      payload: {
        incidentId: INCIDENT,
        runId: RUN_ID,
        text: "Checked the job.\nIt is stuck.",
      },
      source: "agent",
      summary: "Checked the job. It is stuck.",
      type: "investigation.step",
    });
  });

  test("exits 1 with a step failed line when control-plane answers 400", async () => {
    status = 400;
    const result = await run("scripts/step.ts", [step], {
      CONTROL_PLANE_URL: `http://127.0.0.1:${server.port}`,
      HM_RUN_ID: RUN_ID,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("step failed: ");
    expect(result.stdout).toContain("400");
  });

  test("exits 1 with a step failed line when CONTROL_PLANE_URL is unset", async () => {
    const result = await run("scripts/step.ts", [step], { HM_RUN_ID: RUN_ID });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("step failed: CONTROL_PLANE_URL");
    expect(received).toEqual([]);
  });
});
