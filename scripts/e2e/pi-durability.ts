#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, WEB_DIR } from "../dev/local.ts";
// The Pi durability suite, live. Pi Durable is experimental and has broken
// between minor versions, so run this on every bump of the Pi packages. It
// checks three things against a real `vite dev` Worker, with the scripted
// `faux` model and no API key:
//   1. the Pi packages are pinned to exact versions and those are installed;
//   2. unsafe tool: the server is killed (kill -9, whole process group) while
//      a library `bash` call runs. After the restart Pi must not run the tool
//      again, and the model gets the "interrupted" result. Platform tools that
//      are not read-only are `replay: "unsafe"` (pi-run-mcp.ts);
//   3. long outage: the object is down for 120 s with the lease reaper still
//      sweeping, and the run still ends `done` (scripts/e2e/cloud-outage.ts).
// Not covered yet: a `safe` tool, which Pi runs again after a restart. The faux
// model (apps/web/src/server/pi-run-faux.ts) only ever calls `harbourmaster_bash`,
// and no platform tool is both read-only and slow enough to stop in the middle.
// A safe case needs a faux prompt that calls another tool and a slow read-only
// tool in dev builds.
// The bridge's mapping from `readOnlyHint` to `safe` has unit tests in
// apps/web/src/server/pi-run-mcp.test.ts.
//
// The script owns the dev server, like cloud-outage.ts: put
//   PUBLIC_BASE_URL=http://localhost:3917
// in apps/web/.env.local first (use your own port), then from the repo root:
//   bun run e2e:pi-durability [--port 3917] [--log-dir <dir>]
import { CloudError, type SeqEvent } from "./cloud.ts";
import {
  type OutageDeps,
  parseHarnessArgs,
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
const INTERRUPTED = "may have partially run";
// Pi writes the execute checkpoint right after the tool.call entry. Wait this long
// before the kill, so the tool is in flight and not only admitted.
const IN_FLIGHT_MS = 2000;
const TOOL_WAIT_MS = 60_000;
const POLL_MS = 250;
// The library bash tool stops a script after 10 s. The sleep must be shorter.
const TOOL_SLEEP_MS = 8000;
const UNSAFE_SCRIPT = `printf '%s\\n' ran-$((20+22)); sleep ${TOOL_SLEEP_MS / 1000}`;
const UNSAFE_PROMPT = `bash ${UNSAFE_SCRIPT}`;

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
const waitUntilToolRuns = async (deps: OutageDeps, runId: string) => {
  const deadline = deps.now().getTime() + TOOL_WAIT_MS;
  for (;;) {
    const events = deps.eventsOf(runId);
    if (ofType(events, "tool.result").length > 0) {
      throw new CloudError(
        "before the kill: the tool already answered, so there was nothing to interrupt"
      );
    }
    if (ofType(events, "tool.call").length > 0) {
      return;
    }
    if (deps.now().getTime() > deadline) {
      throw new CloudError(
        `before the kill: run ${runId} never called its tool`
      );
    }
    // biome-ignore lint/performance/noAwaitInLoops: polling is sequential by nature
    await deps.sleep(POLL_MS);
  }
};

/** The unsafe case. Throws a CloudError naming the first assertion that fails. */
export const runUnsafe = async (deps: OutageDeps): Promise<void> => {
  const runId = await deps.send(UNSAFE_PROMPT);
  await deps.drive("offer", runId);
  await waitUntilRunning(deps, runId);
  await waitUntilToolRuns(deps, runId);
  await deps.sleep(IN_FLIGHT_MS);
  if (ofType(deps.eventsOf(runId), "tool.result").length > 0) {
    throw new CloudError(
      `before the kill: the tool answered within ${IN_FLIGHT_MS} ms, expected it to sleep ${TOOL_SLEEP_MS} ms`
    );
  }
  deps.out("ok 1: the unsafe tool is running when the server is killed");

  await deps.killServer();
  await deps.startServer();
  const { state } = await waitForEnd(deps, runId);
  if (state.status !== "done") {
    throw new CloudError(
      `unsafe tool: run ${runId} is ${state.status}${state.error ? ` (${state.error})` : ""} after the restart, expected done`
    );
  }
  deps.out("ok 2: the run ends done after the restart");

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

export const main = async (argv: string[]): Promise<void> => {
  const options = parseHarnessArgs(argv, "Pi durability faux");
  const pins = checkPins(realPins());
  process.stdout.write(`ok 0: Pi is pinned exactly: ${pins.join(", ")}\n`);
  await withHarness(options, async (deps) => {
    deps.out("-- unsafe tool");
    await runUnsafe(deps);
    deps.out("-- long outage");
    await runOutage(deps);
  });
  process.stdout.write("pi durability suite passed\n");
};

if (import.meta.main) {
  runCli(() => main(process.argv.slice(2)));
}
