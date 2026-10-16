// The logic of one session's cloud runner, kept free of `cloudflare:workers`
// so bun can test it with a fake Pi and fake storage. `pi-run.ts` wraps it in
// the Durable Object. A run is one Pi submission whose operation id is the run
// id, so a second start of the same run is a no-op, and each run reads its own
// slice of the session's transcript.
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { RunStatus } from "@repo/db/shared";
import type { CloudStart } from "@repo/services/cloud/types";
import { isServiceError } from "@repo/services/errors";
import {
  type RunEventInput,
  type RunResult,
  TERMINAL_STATUSES,
} from "@repo/services/runs/types";
import {
  failureOf,
  finalText,
  sliceRun,
  toRunEvents,
  usageOf,
} from "./pi-run-events.ts";

/** How Pi ended one operation. */
export interface PiOutcome {
  reason?: string;
  status: "done" | "unanswered";
  text?: string;
}

/** The part of one Pi session the runner uses. `pi-run.ts` implements it over `PiHarness`. */
export interface PiPort {
  abort: (operationId: string) => Promise<boolean>;
  busy: () => Promise<boolean>;
  /** The transcript from the entry with this id on, oldest first. Not the model's context: compaction does not cut it. */
  entriesFrom: (start: string) => Promise<readonly EntryRecord[]>;
  /** The id of the user entry an operation's input was placed as (as a string), once it is placed. */
  entryOf: (operationId: string) => Promise<string | undefined>;
  setModel: (model: string) => Promise<void>;
  submit: (
    text: string,
    options: { operationId: string; whenBusy: "followUp" | "steer" }
  ) => Promise<{ accepted: boolean }>;
  wait: (operationId: string) => Promise<PiOutcome>;
  /** Calls `onChange` after Pi commits something. Resolves to the function that stops it. */
  watch: (onChange: () => Promise<void>) => Promise<() => Promise<unknown>>;
}

/** The part of `DurableObjectStorage` the runner uses. */
export interface RunStorage {
  delete: (key: string) => Promise<unknown>;
  get: <T>(key: string) => Promise<T | undefined>;
  put: <T>(key: string, value: T) => Promise<void>;
}

export interface RunCoreDeps {
  complete: (runId: string, result: RunResult) => Promise<void>;
  heartbeat: (runId: string) => Promise<void>;
  /** Milliseconds between lease heartbeats while a run is worked. */
  heartbeatMs?: number;
  ingest: (runId: string, events: RunEventInput[]) => Promise<unknown>;
  /** Lists the run's MCP tools and installs them. Throws when a server cannot be reached. */
  installTools: (input: CloudStart) => Promise<void>;
  pi: PiPort;
  sleep?: (ms: number) => Promise<void>;
  /** The run's status on the platform. */
  statusOf: (runId: string) => Promise<RunStatus>;
  storage: RunStorage;
}

interface StoredRun {
  /** The user entry Pi placed the input as. Known once placed. */
  entry?: string;
  /** The agent's model, so a run submitted again after a wake uses it. */
  model: string;
  state: "active" | "finished";
  /** The input, so a run whose submission never reached Pi can be submitted again. */
  text: string;
}

/** The newest run's MCP servers, with the run token. Tools read it on every call. */
export const SERVERS_KEY = "mcp-servers";
const RUNS_KEY = "runs";
const runKey = (runId: string) => `run:${runId}`;

export const HEARTBEAT_MS = 20_000;
const COMPLETE_ATTEMPTS = 3;
const COMPLETE_BACKOFF_MS = 1000;
const NO_ERROR_TEXT = "The model did not answer";

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A write the platform refused because the run is no longer running. */
const isRunGone = (error: unknown): boolean =>
  isServiceError(error) && error.code === "conflict";

export const createRunCore = ({
  complete,
  heartbeat,
  heartbeatMs = HEARTBEAT_MS,
  ingest,
  installTools,
  pi,
  sleep = defaultSleep,
  statusOf,
  storage,
}: RunCoreDeps) => {
  const following = new Map<string, Promise<void>>();

  const load = (runId: string) => storage.get<StoredRun>(runKey(runId));

  const save = (runId: string, run: StoredRun) =>
    storage.put(runKey(runId), run);

  const knownRuns = async () => (await storage.get<string[]>(RUNS_KEY)) ?? [];

  /** The user entry of a run, from storage or, once Pi has placed the input, from Pi. */
  const entryOf = async (runId: string): Promise<string | undefined> => {
    const run = await load(runId);
    if (!run) {
      return;
    }
    if (run.entry) {
      return run.entry;
    }
    const placed = await pi.entryOf(runId);
    if (placed) {
      await save(runId, { ...run, entry: placed });
    }
    return placed;
  };

  /**
   * The run's own entries: from its user entry up to the next user entry of
   * another run of the session. Two runs in a session share one transcript,
   * and each must report only what it did.
   */
  const sliceOf = async (runId: string): Promise<EntryRecord[]> => {
    const start = await entryOf(runId);
    if (!start) {
      return [];
    }
    const entries = await pi.entriesFrom(start);
    const others = await Promise.all(
      (await knownRuns())
        .filter((other) => other !== runId)
        .map((other) => entryOf(other))
    );
    const end = entries
      .slice(1)
      .find((entry) => others.includes(String(entry.id)));
    return sliceRun(entries, start, end ? String(end.id) : undefined);
  };

  /** Sends what the run has not sent yet. The platform skips a seq it already holds, so a resend after a wake is safe. */
  const report = async (runId: string, sent: { count: number }) => {
    const slice = await sliceOf(runId);
    const events = toRunEvents(slice);
    if (events.length > sent.count) {
      await ingest(runId, events.slice(sent.count));
      sent.count = events.length;
    }
    return slice;
  };

  /**
   * Whether the platform has ended the run (done, failed, cancelled,
   * interrupted). A run it put back for another claim after a start that
   * looked failed (`releaseRun`) is not over: the work goes on, the sweep
   * offers the run again, and the second start finds it here and reports it.
   */
  const isOver = async (runId: string) =>
    TERMINAL_STATUSES.includes(await statusOf(runId));

  const abortQuietly = async (runId: string) => {
    try {
      await pi.abort(runId);
    } catch (error) {
      console.error(`PiRun: stopping run ${runId}: ${describe(error)}`);
    }
  };

  const finishRun = async (runId: string) => {
    const run = await load(runId);
    if (run) {
      await save(runId, { ...run, state: "finished" });
    }
    // The run token has no use once no run of the session is active.
    const states = await Promise.all((await knownRuns()).map(load));
    if (states.every((other) => other?.state !== "active")) {
      await storage.delete(SERVERS_KEY);
    }
  };

  const resultOf = (outcome: PiOutcome, slice: EntryRecord[]): RunResult => {
    const usage = usageOf(slice);
    if (outcome.status === "done") {
      return {
        status: "done",
        text: finalText(slice) || outcome.text || "",
        usage,
      };
    }
    return {
      error: failureOf(slice) ?? outcome.reason ?? NO_ERROR_TEXT,
      status: "failed",
      usage,
    };
  };

  const completeWithRetry = async (runId: string, result: RunResult) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: each attempt follows the failure of the one before
        await complete(runId, result);
        return;
      } catch (error) {
        if (isRunGone(error) || attempt >= COMPLETE_ATTEMPTS) {
          throw error;
        }
        await sleep(COMPLETE_BACKOFF_MS * attempt);
      }
    }
  };

  /**
   * Completes the run. "waiting" means the platform put the run back for
   * another claim, so the report waits for the second start.
   */
  const completeRun = async (
    runId: string,
    result: RunResult
  ): Promise<"completed" | "over" | "waiting"> => {
    for (let round = 1; ; round += 1) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: a second round follows a refusal of the first
        await completeWithRetry(runId, result);
        return "completed";
      } catch (error) {
        if (!isRunGone(error)) {
          throw error;
        }
        const status = await statusOf(runId);
        if (TERMINAL_STATUSES.includes(status)) {
          return "over";
        }
        // Claimed again between the refusal and the read: one more try.
        if (status !== "running" || round >= COMPLETE_ATTEMPTS) {
          return "waiting";
        }
      }
    }
  };

  const work = async (runId: string): Promise<void> => {
    if ((await load(runId))?.state !== "active") {
      return;
    }
    const sent = { count: 0 };
    let slice: EntryRecord[] = [];
    // Flushes never overlap: two that read the same last seq would write it twice.
    // A step catches its own failures, so one failed flush cannot stop the next.
    let chain: Promise<void> = Promise.resolve();
    let gone = false;
    const step = async () => {
      if (gone) {
        return;
      }
      try {
        slice = await report(runId, sent);
      } catch (error) {
        if (!isRunGone(error)) {
          console.error(`PiRun: reporting run ${runId}: ${describe(error)}`);
          return;
        }
        if (await isOver(runId)) {
          gone = true;
          await abortQuietly(runId);
        }
      }
    };
    const flush = (): Promise<void> => {
      chain = chain.then(step).catch((error: unknown) => {
        console.error(`PiRun: flushing run ${runId}: ${describe(error)}`);
      });
      return chain;
    };
    const beat = setInterval(() => {
      heartbeat(runId).catch((error: unknown) => {
        // A run waiting for its second claim refuses heartbeats, and says nothing new.
        if (!isRunGone(error)) {
          console.error(`PiRun: heartbeat for ${runId}: ${describe(error)}`);
        }
      });
    }, heartbeatMs);
    let stop: (() => Promise<unknown>) | undefined;
    try {
      stop = await pi.watch(flush);
      const outcome = await pi.wait(runId);
      await stop();
      stop = undefined;
      await flush();
      if (!gone) {
        const done = await completeRun(runId, resultOf(outcome, slice));
        if (done === "waiting") {
          return;
        }
      }
      await finishRun(runId);
    } finally {
      clearInterval(beat);
      await stop?.().catch(() => undefined);
    }
  };

  const again = new Set<string>();

  const follow = (runId: string) => {
    if (following.has(runId)) {
      // A start that lands as the work ends would be lost, so the work runs once more.
      again.add(runId);
      return;
    }
    const job = work(runId)
      .catch((error: unknown) => {
        // The run stays active: the next wake of the object works it again.
        console.error(`PiRun: working run ${runId}: ${describe(error)}`);
      })
      .finally(() => {
        following.delete(runId);
        if (again.delete(runId)) {
          follow(runId);
        }
      });
    following.set(runId, job);
  };

  /**
   * Starts working a run. A second start of the same run submits nothing new
   * (Pi answers `accepted: false`) and only refreshes the run token. A run
   * that arrives while the session is busy joins the work in progress.
   */
  const startOnce = async (input: CloudStart): Promise<void> => {
    const { run } = input;
    const existing = await load(run.id);
    if (existing?.state === "finished") {
      return;
    }
    if (!existing) {
      await installTools(input);
    }
    await storage.put(SERVERS_KEY, input.mcpServers);
    if (!existing) {
      await save(run.id, {
        model: input.agent.model,
        state: "active",
        text: run.inputText,
      });
      await storage.put(RUNS_KEY, [...(await knownRuns()), run.id]);
    }
    const busy = await pi.busy();
    if (!busy) {
      await pi.setModel(input.agent.model);
    }
    await pi.submit(run.inputText, {
      operationId: run.id,
      whenBusy: busy ? "steer" : "followUp",
    });
    follow(run.id);
  };

  // Two starts of one run at the same moment (a duplicate dispatch) take turns.
  let starting: Promise<unknown> = Promise.resolve();
  const start = (input: CloudStart): Promise<void> => {
    const turn = starting.then(() => startOnce(input));
    starting = turn.catch(() => undefined);
    return turn;
  };

  /** Stops a run's work. A run this object never saw is ignored. */
  const cancel = async (runId: string): Promise<void> => {
    const run = await load(runId);
    if (run?.state !== "active") {
      return;
    }
    await pi.abort(runId);
    follow(runId);
  };

  /** After a wake: works every run that has not finished. */
  const resume = async (): Promise<void> => {
    for (const runId of await knownRuns()) {
      // biome-ignore lint/performance/noAwaitInLoops: a handful of runs, read in order
      const run = await load(runId);
      if (run?.state === "active") {
        // Submitting again is a no-op when Pi has the run, and covers a start that stopped before its submit.
        if (!(await pi.busy())) {
          await pi.setModel(run.model);
        }
        await pi.submit(run.text, { operationId: runId, whenBusy: "followUp" });
        follow(runId);
      }
    }
  };

  return { cancel, resume, start };
};

export type RunCore = ReturnType<typeof createRunCore>;
