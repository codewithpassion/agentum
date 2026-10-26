#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, WEB_DIR } from "../dev/local.ts";
// The Pi durability suite, live. Pi Durable is experimental and has broken
// between minor versions, so run this on every bump of the Pi packages. It
// checks four things against a real `vite dev` Worker, with the scripted
// `faux` model and no API key:
//   1. the Pi packages are pinned to exact versions and those are installed;
//   2. unsafe tool: the server is killed (kill -9, whole process group) while
//      a library `bash` call runs. After the restart Pi must not run the tool
//      again, and the model gets the "interrupted" result. Platform tools that
//      are not read-only are `replay: "unsafe"` (pi-run-mcp.ts);
//   3. safe tool: the server is killed while the dev-only `dev_slow_read` tool
//      runs (`replay: "safe"`, apps/web/src/server/pi-run-dev-tools.ts). After
//      the restart Pi runs it again, so its output says `started 2 times` and
//      the model answers with that text;
//   4. approval wait: a tool rule `ask` on the dev-only `dev_gated` tool
//      (not replay safe, its output counts its runs in the object's storage)
//      opens one request, and the run waits. The server is killed and started
//      again while it waits. The request is still pending and the run still
//      waiting. Then the answer resumes the run, and the tool runs once;
//   5. long outage: the object is down for 120 s with the lease reaper still
//      sweeping, and the run still ends `done` (scripts/e2e/cloud-outage.ts).
// The faux model (apps/web/src/server/pi-run-faux.ts) calls the tool named in
// its `call <tool> <json>` prompt.
// The bridge's mapping from `readOnlyHint` to `safe` has unit tests in
// apps/web/src/server/pi-run-mcp.test.ts.
//
// The script owns the dev server, like cloud-outage.ts: put
//   PUBLIC_BASE_URL=http://localhost:3917
// in apps/web/.env.local first (use your own port), then from the repo root:
//   bun run e2e:pi-durability [--port 3917] [--log-dir <dir>]
import { CloudError, type SeqEvent } from "./cloud.ts";
import {
  describeError,
  isTerminal,
  type OutageDeps,
  parseHarnessArgs,
  type RunState,
  runOutage,
  waitForEnd,
  waitUntilRunning,
  withHarness,
} from "./cloud-outage.ts";

/** The packages whose versions decide how Pi behaves. */
export const PI_PACKAGES = [
  "@earendil-works/chord",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-durable",
  "agents",
  "typebox",
] as const;

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
// The script prints a marker that is not in the script text, so a rerun shows in the output.
const MARKER = "ran-42";
export const INTERRUPTED = "may have partially run";
// The dev-only read-only tool (pi-run-dev-tools.ts). Its result says how many times it started.
export const SAFE_PROMPT = "call dev_slow_read {}";
export const SAFE_RERUN_TEXT = "started 2 times";
// Pi writes the execute checkpoint right after the tool.call entry. Wait this long
// before the kill, so the tool is in flight and not only admitted.
const IN_FLIGHT_MS = 2000;
const TOOL_WAIT_MS = 60_000;
const POLL_MS = 250;
// The library bash tool stops a script after 10 s. The sleep must be shorter.
const TOOL_SLEEP_MS = 8000;
const UNSAFE_SCRIPT = `printf '%s\\n' ran-$((20+22)); sleep ${TOOL_SLEEP_MS / 1000}`;
const UNSAFE_PROMPT = `bash ${UNSAFE_SCRIPT}`;
// The dev-only tool behind an approval (pi-run-dev-tools.ts). The faux prompt `gated` makes the model call it.
export const GATED_PROMPT = "gated";
export const GATED_TOOL = "dev_gated";
export const GATED_RAN_TEXT = "gated ran 1 times";
const WAITING_TIMEOUT_MS = 60_000;
// After the restart the run must still wait on its request for this long.
const RESTART_SETTLE_MS = 5000;

/** What the script reads from the package manifest and the install. */
export interface PinDeps {
  /** The version range `apps/web/package.json` names, or undefined. */
  declared: (name: string) => string | undefined;
  /** The version in `node_modules`, or undefined. */
  installed: (name: string) => string | undefined;
}

/** Every Pi package is pinned to an exact version and that version is installed. */
export const checkPins = (deps: PinDeps): string[] => {
  const lines: string[] = [];
  for (const name of PI_PACKAGES) {
    const declared = deps.declared(name);
    if (declared === undefined || !EXACT_VERSION.test(declared)) {
      throw new CloudError(
        `${name} is "${declared}" in apps/web/package.json, expected an exact version`
      );
    }
    const installed = deps.installed(name);
    if (installed !== declared) {
      throw new CloudError(
        `${name} is pinned to ${declared} but ${installed ?? "nothing"} is installed. Run bun install.`
      );
    }
    lines.push(`${name}@${declared}`);
  }
  return lines;
};

const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, "utf8"));

const realPins = (): PinDeps => {
  const manifest = readJson(join(WEB_DIR, "package.json"));
  const dependencies = {
    ...(manifest.dependencies as Record<string, string>),
    ...(manifest.devDependencies as Record<string, string>),
  };
  return {
    declared: (name) => dependencies[name],
    installed: (name) => {
      const file = join(WEB_DIR, "node_modules", name, "package.json");
      return existsSync(file) ? String(readJson(file).version) : undefined;
    },
  };
};

const ofType = (events: SeqEvent[], type: string): SeqEvent[] =>
  events.filter((event) => event.type === type);

/** Polls until the run has called its tool and the tool has not answered. */
const waitUntilToolRuns = async (
  deps: OutageDeps,
  runId: string,
  label: string
) => {
  const deadline = deps.now().getTime() + TOOL_WAIT_MS;
  for (;;) {
    const events = deps.eventsOf(runId);
    if (ofType(events, "tool.result").length > 0) {
      throw new CloudError(
        `${label}: before the kill: the tool already answered, so there was nothing to interrupt`
      );
    }
    if (ofType(events, "tool.call").length > 0) {
      return;
    }
    if (deps.now().getTime() > deadline) {
      throw new CloudError(
        `${label}: before the kill: run ${runId} never called its tool`
      );
    }
    // biome-ignore lint/performance/noAwaitInLoops: polling is sequential by nature
    await deps.sleep(POLL_MS);
  }
};

/** Starts a run, and waits until its tool is in flight with no answer yet. Returns the run id. */
const startInFlight = async (
  deps: OutageDeps,
  prompt: string,
  label: string
): Promise<string> => {
  const runId = await deps.send(prompt);
  await deps.drive("offer", runId);
  await waitUntilRunning(deps, runId);
  await waitUntilToolRuns(deps, runId, label);
  await deps.sleep(IN_FLIGHT_MS);
  if (ofType(deps.eventsOf(runId), "tool.result").length > 0) {
    throw new CloudError(
      `${label}: before the kill: the tool answered within ${IN_FLIGHT_MS} ms, expected it to sleep ${TOOL_SLEEP_MS} ms`
    );
  }
  deps.out(`ok 1: the ${label} is running when the server is killed`);
  return runId;
};

/** Kills and restarts the server, then checks the run ends done. Returns its final state. */
const killAndFinish = async (
  deps: OutageDeps,
  runId: string,
  label: string
): Promise<RunState> => {
  await deps.killServer();
  await deps.startServer();
  const { state } = await waitForEnd(deps, runId);
  if (state.status !== "done") {
    throw new CloudError(
      `${label}: run ${runId} is ${state.status}${state.error ? ` (${state.error})` : ""} after the restart, expected done`
    );
  }
  deps.out("ok 2: the run ends done after the restart");
  return state;
};

/** The unsafe case. Throws a CloudError naming the first assertion that fails. */
export const runUnsafe = async (deps: OutageDeps): Promise<void> => {
  const label = "unsafe tool";
  const runId = await startInFlight(deps, UNSAFE_PROMPT, label);
  const state = await killAndFinish(deps, runId, label);

  const events = deps.eventsOf(runId);
  const calls = ofType(events, "tool.call");
  const results = ofType(events, "tool.result");
  if (calls.length !== 1 || results.length !== 1) {
    throw new CloudError(
      `unsafe tool: expected one tool.call and one tool.result, got ${calls.length} and ${results.length}`
    );
  }
  const output = results
    .map((result) => String(result.payload.output ?? ""))
    .join("\n");
  if (output.includes(MARKER)) {
    throw new CloudError(
      `unsafe tool: Pi ran the tool again after the restart, its output was ${JSON.stringify(output)}`
    );
  }
  if (!output.includes(INTERRUPTED)) {
    throw new CloudError(
      `unsafe tool: expected the interrupted result (${INTERRUPTED}), got ${JSON.stringify(output)}`
    );
  }
  deps.out("ok 3: Pi does not run the unsafe tool again");

  if (!state.resultText?.includes(INTERRUPTED)) {
    throw new CloudError(
      `unsafe tool: the model should have seen the interrupted result, its answer was ${JSON.stringify(state.resultText)}`
    );
  }
  deps.out("ok 4: the model gets the interrupted result");
};

/** Polls until the run waits on a pending request. Throws when the run ends first. */
const waitUntilWaiting = async (
  deps: OutageDeps,
  runId: string,
  label: string
): Promise<string> => {
  const deadline = deps.now().getTime() + WAITING_TIMEOUT_MS;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: polling is sequential by nature
    const state = await deps.runOf(runId);
    const requestId = deps.pendingRequestId(runId);
    if (requestId !== undefined && state.status === "waiting") {
      return requestId;
    }
    if (isTerminal(state.status)) {
      throw new CloudError(
        `${label}: run ${runId} is ${state.status}${describeError(state)} before it waited for an answer`
      );
    }
    if (deps.now().getTime() > deadline) {
      throw new CloudError(
        `${label}: run ${runId} never waited for an answer (status ${state.status}, pending request ${requestId ?? "none"})`
      );
    }
    await deps.sleep(POLL_MS);
  }
};

/** The approval case. Throws a CloudError naming the first assertion that fails. */
export const runWaiting = async (deps: OutageDeps): Promise<void> => {
  const label = "waiting";
  await deps.setRule(GATED_TOOL, "ask");
  const runId = await deps.send(GATED_PROMPT);
  await deps.drive("offer", runId);
  const requestId = await waitUntilWaiting(deps, runId, label);
  deps.out("ok 1: the run waits on one approval request");

  await deps.killServer();
  await deps.startServer();
  await deps.sleep(RESTART_SETTLE_MS);
  const before = await deps.runOf(runId);
  if (deps.pendingRequestId(runId) !== requestId) {
    throw new CloudError(
      `${label}: request ${requestId} is no longer pending after the restart`
    );
  }
  if (before.status !== "waiting") {
    throw new CloudError(
      `${label}: run ${runId} is ${before.status}${describeError(before)} after the restart, expected waiting`
    );
  }
  deps.out(
    "ok 2: the request is still pending and the run waits after the restart"
  );

  await deps.answer(requestId, "allow_once");
  const { state } = await waitForEnd(deps, runId);
  if (state.status !== "done") {
    throw new CloudError(
      `${label}: run ${runId} is ${state.status}${describeError(state)} after the answer, expected done`
    );
  }
  deps.out("ok 3: the run ends done once the request is answered");

  const events = deps.eventsOf(runId);
  const types = deps.eventTypesOf(runId);
  const countOf = (type: string) =>
    types.filter((other) => other === type).length;
  const opened = countOf("request.opened");
  const waiting = countOf("run.waiting");
  const resumed = countOf("run.resumed");
  if (opened !== 1 || waiting < 1 || resumed < 1) {
    throw new CloudError(
      `${label}: expected one request.opened, a run.waiting and a run.resumed, got ${opened}, ${waiting} and ${resumed}`
    );
  }
  deps.out("ok 4: the run opens one request, waits and resumes");

  const results = ofType(events, "tool.result");
  const [result] = results;
  if (results.length !== 1 || result === undefined) {
    throw new CloudError(
      `${label}: expected one tool.result, got ${results.length}`
    );
  }
  const output = String(result.payload.output ?? "");
  if (!output.includes(GATED_RAN_TEXT)) {
    throw new CloudError(
      `${label}: expected the gated tool to run once (${GATED_RAN_TEXT}), got ${JSON.stringify(output)}`
    );
  }
  deps.out("ok 5: the gated tool runs once");

  if (!state.resultText?.includes(GATED_RAN_TEXT)) {
    throw new CloudError(
      `${label}: the model should have seen the gated result (${GATED_RAN_TEXT}), its answer was ${JSON.stringify(state.resultText)}`
    );
  }
  deps.out("ok 6: the model gets the gated result");
};

/** The safe case. Throws a CloudError naming the first assertion that fails. */
export const runSafe = async (deps: OutageDeps): Promise<void> => {
  const label = "safe tool";
  const runId = await startInFlight(deps, SAFE_PROMPT, label);
  const state = await killAndFinish(deps, runId, label);

  const events = deps.eventsOf(runId);
  const calls = ofType(events, "tool.call");
  const results = ofType(events, "tool.result");
  if (calls.length < 1 || results.length !== 1) {
    throw new CloudError(
      `safe tool: expected at least one tool.call and one tool.result, got ${calls.length} and ${results.length}`
    );
  }
  const output = results
    .map((result) => String(result.payload.output ?? ""))
    .join("\n");
  if (output.includes(INTERRUPTED)) {
    throw new CloudError(
      `safe tool: Pi marked the tool as interrupted, but it is safe to run again, its output was ${JSON.stringify(output)}`
    );
  }
  if (!output.includes(SAFE_RERUN_TEXT)) {
    throw new CloudError(
      `safe tool: expected the tool to run again (${SAFE_RERUN_TEXT}), got ${JSON.stringify(output)}`
    );
  }
  deps.out("ok 3: Pi runs the safe tool again");

  if (!state.resultText?.includes(SAFE_RERUN_TEXT)) {
    throw new CloudError(
      `safe tool: the model should have seen the rerun result (${SAFE_RERUN_TEXT}), its answer was ${JSON.stringify(state.resultText)}`
    );
  }
  deps.out("ok 4: the model gets the rerun result");
};

export const main = async (argv: string[]): Promise<void> => {
  const options = parseHarnessArgs(argv, "Pi durability faux");
  const pins = checkPins(realPins());
  process.stdout.write(`ok 0: Pi is pinned exactly: ${pins.join(", ")}\n`);
  await withHarness(options, async (deps) => {
    deps.out("-- unsafe tool");
    await runUnsafe(deps);
    deps.out("-- safe tool");
    await runSafe(deps);
    deps.out("-- waiting for an answer");
    await runWaiting(deps);
    deps.out("-- long outage");
    await runOutage(deps);
  });
  process.stdout.write("pi durability suite passed\n");
};

if (import.meta.main) {
  runCli(() => main(process.argv.slice(2)));
}
