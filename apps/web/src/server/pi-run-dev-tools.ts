// A slow read-only tool for the Pi durability suite (`scripts/e2e/pi-durability.ts`).
// `PiRun` loads this module in dev builds only, behind `import.meta.env.DEV`, so a
// deployed Worker never registers the tool. The scripted `faux` model calls it with
// the prompt `call dev_slow_read`.
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

export const SLOW_READ_TOOL = "dev_slow_read";
/** The sleep, shorter than the library bash tool's 10 s limit so the two cases stay alike. */
export const SLOW_READ_MS = 8000;
/** How many times the tool has started, kept in the object's storage so a restart does not reset it. */
export const SLOW_READ_COUNT_KEY = "dev-slow-read-starts";

export const GATED_TOOL = "dev_gated";
/** How many times the gated tool has run, kept in the object's storage. */
export const GATED_COUNT_KEY = "dev-gated-runs";

/** The two calls the tool needs from its host: a start counter and a sleep that an abort ends. */
export interface SlowReadDeps {
  /** Counts one start and returns the new total. */
  countStart: () => Promise<number>;
  sleepMs?: number;
}

const sleepUntil = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });

/**
 * A read-only tool that sleeps. It is `replay: "safe"`, so Pi runs it again when
 * the object dies in the middle. Its result names the start count, so a rerun
 * shows as `started 2 times`.
 */
export const slowReadTool = ({
  countStart,
  sleepMs = SLOW_READ_MS,
}: SlowReadDeps): ToolRegistration => ({
  description:
    "Dev only. Reads nothing, sleeps a few seconds, and says how many times it has started.",
  execute: async (_args, _api, context) => {
    const starts = await countStart();
    await sleepUntil(sleepMs, context.abortSignal);
    return {
      isError: false,
      output: [
        { text: `slow read done, started ${starts} times`, type: "text" },
      ],
    };
  },
  name: SLOW_READ_TOOL,
  parameters: Type.Object({}),
  replay: "safe",
});

/** The call the gated tool needs from its host: a run counter. */
export interface GatedDeps {
  /** Counts one run and returns the new total. */
  countRun: () => Promise<number>;
}

/**
 * A tool with an effect, so it is not replay safe: Pi does not run it again when
 * the object dies in the middle. Its result names the run count.
 */
export const gatedTool = ({ countRun }: GatedDeps): ToolRegistration => ({
  description: "Dev only. Does nothing, and says how many times it has run.",
  execute: async () => {
    const runs = await countRun();
    return {
      isError: false,
      output: [{ text: `gated ran ${runs} times`, type: "text" }],
    };
  },
  name: GATED_TOOL,
  parameters: Type.Object({}),
});

/** The storage calls the counters need. */
interface CounterStorage {
  get: (key: string) => Promise<unknown>;
  put: (key: string, value: number) => Promise<void>;
}

/** Adds one to the number stored under `key` and returns the new total. */
const countIn =
  (storage: CounterStorage, key: string) => async (): Promise<number> => {
    const previous = await storage.get(key);
    const total = (typeof previous === "number" ? previous : 0) + 1;
    await storage.put(key, total);
    return total;
  };

/** The registry extension `PiRun` installs in dev builds. */
export const devToolsExtension = (storage: CounterStorage) => ({
  name: "dev-tools",
  tools: [
    slowReadTool({ countStart: countIn(storage, SLOW_READ_COUNT_KEY) }),
    gatedTool({ countRun: countIn(storage, GATED_COUNT_KEY) }),
  ],
});
