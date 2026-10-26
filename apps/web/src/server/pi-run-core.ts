// The logic of one session's cloud runner, kept free of `cloudflare:workers`
// so bun can test it with a fake Pi and fake storage. `pi-run.ts` wraps it in
// the Durable Object. A run is one Pi submission whose operation id is the run
// id, so a second start of the same run is a no-op, and each run reads its own
// slice of the session's transcript. `beat` runs on the object's alarm every
// HEARTBEAT_MS: it heartbeats the active runs and works again any run the
// object is not following.
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { RunStatus } from "@repo/db/shared";
import {
  MAX_TURNS_DEFAULT,
  maxTurnsOf,
  REPEAT_STOP_AT,
  type RunStop,
  stopMessage,
  streakOf,
} from "@repo/protocol/safeguards";
import type { CloudStart } from "@repo/services/cloud/types";
import { isServiceError } from "@repo/services/errors";
import { RUN_TOKEN_MAX_AGE_MS } from "@repo/services/run-tokens";
import {
  type RunEventInput,
  type RunResult,
  TERMINAL_STATUSES,
} from "@repo/services/runs/types";
import {
  failureOf,
  finalText,
  sliceRun,
  toolOutcomesOf,
  toRunEvents,
  turnsOf,
  usageOf,
  wantsAnotherTurn,
} from "./pi-run-events.ts";
import type { PiInput } from "./pi-run-files.ts";

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
  /** Sets the session's system prompt section for the agent's instructions; applies from the next request. */
  setInstructions: (instructions: string) => Promise<void>;
  setModel: (model: string) => Promise<void>;
  submit: (
    input: PiInput,
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

/** The run a file call is made for. The services decide what that run may read and write. */
export interface RunRef {
  agentId: string;
  runId: string;
  workspaceId: string;
}

/** The answer after its `[ATTACHMENT:path]` markers became uploaded files. */
export interface RunOutputs {
  fileIds: string[];
  text: string;
}

export interface RunCoreDeps {
  complete: (runId: string, result: RunResult) => Promise<void>;
  /** Extends a run's lease. Called by `beat`. */
  heartbeat: (runId: string) => Promise<void>;
  ingest: (runId: string, events: RunEventInput[]) => Promise<unknown>;
  /** The run's message as Pi takes it: its text, and its input files as image blocks or a list. `model` is the agent's model string. */
  inputOf: (
    run: RunRef,
    text: string,
    fileIds: readonly string[],
    model: string
  ) => Promise<PiInput>;
  /** Loads the run's skills and installs them. A throw is logged and the run goes on without them. */
  installSkills: (input: CloudStart) => Promise<void>;
  /** Lists the run's MCP tools and installs them. Throws when a server cannot be reached. */
  installTools: (input: CloudStart) => Promise<void>;
  /** A message when the agent's model cannot run, undefined when it can. */
  modelError: (model: string) => string | undefined;
  /** Epoch milliseconds. A run older than its run token is not heartbeated. */
  now?: () => number;
  /** Uploads the files the final answer names and returns their ids with the answer cleaned of its markers. */
  outputsOf: (run: RunRef, text: string) => Promise<RunOutputs>;
  pi: PiPort;
  sleep?: (ms: number) => Promise<void>;
  /** The run's status on the platform. */
  statusOf: (runId: string) => Promise<RunStatus>;
  storage: RunStorage;
}

interface StoredRun {
  agentId: string;
  /** The user entry Pi placed the input as. Known once placed. */
  entry?: string;
  /** The input files, so a run submitted again after a wake sends them again. */
  fileIds: string[];
  /** The agent's instructions, so a run submitted again after a wake uses them. */
  instructions: string;
  /** The turn limit the run was started with. Absent on records saved before it existed: `MAX_TURNS_DEFAULT`. */
  maxTurns?: number;
  /** The agent's model, so a run submitted again after a wake uses it. */
  model: string;
  /** The uploaded output files, kept so a completion that is tried again does not upload them twice. */
  outputs?: RunOutputs;
  /** When the run was first started, from `now()`. */
  startedAt: number;
  state: "active" | "finished";
  /** The safeguard that stopped the run, kept from the moment it is found: Pi's transcript changes once the abort lands. */
  stop?: RunStop;
  /** Whether the abort for the saved stop has gone through. Until it has, every flush tries it again. */
  stopAborted?: boolean;
  /** The input, so a run whose submission never reached Pi can be submitted again. */
  text: string;
  workspaceId: string;
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

/** The safeguard that ends a run at this point, or undefined while it may go on. */
const stopOf = (
  slice: readonly EntryRecord[],
  maxTurns: number
): RunStop | undefined => {
  const streak = streakOf(toolOutcomesOf(slice));
  if (streak && streak.count >= REPEAT_STOP_AT) {
    return { count: streak.count, kind: "repeat", tool: streak.tool };
  }
  if (turnsOf(slice) >= maxTurns && wantsAnotherTurn(slice)) {
    return { kind: "turn_limit", limit: maxTurns };
  }
};

const refOf = (runId: string, run: StoredRun): RunRef => ({
  agentId: run.agentId,
  runId,
  workspaceId: run.workspaceId,
});

export const createRunCore = ({
  complete,
  heartbeat,
  ingest,
  inputOf,
  installSkills,
  installTools,
  modelError,
  now = Date.now,
  outputsOf,
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

  /** Whether the abort call went through. A failed one is tried again by the next flush. */
  const abortQuietly = async (runId: string): Promise<boolean> => {
    try {
      await pi.abort(runId);
      return true;
    } catch (error) {
      console.error(`PiRun: stopping run ${runId}: ${describe(error)}`);
      return false;
    }
  };

  /** Keeps the first stop found on the stored run, so the result names it after the abort changes the transcript. */
  const saveStop = async (runId: string, stop: RunStop) => {
    const run = await load(runId);
    if (run && !run.stop) {
      await save(runId, { ...run, stop });
    }
  };

  /**
   * Aborts Pi for the run's stop: the one saved on the run, else the one found in this slice. The saved stop wins, as the streak may have broken since. Every flush tries the abort again until it goes through, then saves `stopAborted`, so no later flush or wake repeats it.
   */
  const stopRun = async (
    runId: string,
    slice: readonly EntryRecord[],
    maxTurns: number
  ) => {
    const stored = await load(runId);
    const stop = stored?.stop ?? stopOf(slice, maxTurns);
    if (!stop || stored?.stopAborted === true) {
      return;
    }
    await saveStop(runId, stop);
    if (await abortQuietly(runId)) {
      const current = await load(runId);
      if (current) {
        await save(runId, { ...current, stopAborted: true });
      }
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

  /** The result of a run Pi ended: the safeguard's stop when one ended the model before it answered, else what Pi reported. */
  const finalResultOf = async (
    runId: string,
    outcome: PiOutcome,
    slice: EntryRecord[],
    maxTurns: number
  ): Promise<RunResult> => {
    const stop =
      outcome.status === "done"
        ? undefined
        : ((await load(runId))?.stop ?? stopOf(slice, maxTurns));
    if (!stop) {
      return resultOf(outcome, slice);
    }
    return {
      error: stopMessage(stop),
      status: "failed",
      stop,
      usage: usageOf(slice),
    };
  };

  /** A finished run's result with its output files uploaded once, however often the completion is tried. */
  const withOutputs = async (
    runId: string,
    result: RunResult
  ): Promise<RunResult> => {
    const run = await load(runId);
    if (result.status !== "done" || !run) {
      return result;
    }
    const outputs =
      run.outputs ?? (await outputsOf(refOf(runId, run), result.text ?? ""));
    if (!run.outputs) {
      await save(runId, { ...run, outputs });
    }
    return { ...result, fileIds: outputs.fileIds, text: outputs.text };
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
   * Completes the run. The result "waiting" is not the run status: it means the
   * platform refused the report and the run is neither running nor waiting for
   * a person, so the report waits for the next start.
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
        // Still live (running, or waiting on a person) between the refusal and the read: one more try.
        const live = status === "running" || status === "waiting";
        if (!live || round >= COMPLETE_ATTEMPTS) {
          return "waiting";
        }
      }
    }
  };

  const work = async (runId: string): Promise<void> => {
    const run = await load(runId);
    if (run?.state !== "active") {
      return;
    }
    const limit = run.maxTurns ?? MAX_TURNS_DEFAULT;
    const sent = { count: 0 };
    let slice: EntryRecord[] = [];
    // Flushes never overlap: two that read the same last seq would write it twice.
    // A step catches its own failures, so one failed flush cannot stop the next.
    let chain: Promise<void> = Promise.resolve();
    let gone = false;
    // Whether the last flush put everything Pi had committed on the platform.
    let delivered = true;
    const step = async () => {
      if (gone) {
        return;
      }
      try {
        slice = await report(runId, sent);
        delivered = true;
        await stopRun(runId, slice, limit);
      } catch (error) {
        delivered = false;
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
    let stop: (() => Promise<unknown>) | undefined;
    try {
      stop = await pi.watch(flush);
      const outcome = await pi.wait(runId);
      await stop();
      stop = undefined;
      // The result is built from what was reported, so the last flush has to land.
      for (let attempt = 1; ; attempt += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: each attempt follows the failure of the one before
        await flush();
        if (gone || delivered || attempt >= COMPLETE_ATTEMPTS) {
          break;
        }
        await sleep(COMPLETE_BACKOFF_MS * attempt);
      }
      if (!(gone || delivered)) {
        // The run stays active: the next start or wake reports it.
        return;
      }
      if (!gone) {
        const done = await completeRun(
          runId,
          await withOutputs(
            runId,
            await finalResultOf(runId, outcome, slice, limit)
          )
        );
        if (done === "waiting") {
          return;
        }
      }
      await finishRun(runId);
    } finally {
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
        // The run stays active: the next beat of the alarm works it again.
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
  const startOnce = async (input: CloudStart): Promise<string | undefined> => {
    const { run } = input;
    const existing = await load(run.id);
    if (existing?.state === "finished") {
      return;
    }
    if (!existing) {
      const modelIssue = modelError(input.agent.model);
      if (modelIssue) {
        // The caller fails the run once this turn is over, see `start`.
        return modelIssue;
      }
      await installTools(input);
      // A skill list that cannot be read (over the cap, storage down) must not hold the run back: the sweep would offer it again for ever.
      await installSkills(input).catch((error: unknown) => {
        console.warn(
          `PiRun: skills for run ${run.id} not loaded: ${describe(error)}`
        );
      });
      await save(run.id, {
        agentId: run.agentId,
        fileIds: input.inputFileIds,
        instructions: input.agent.instructions,
        maxTurns: maxTurnsOf(input.agent.runtimeConfig),
        model: input.agent.model,
        startedAt: now(),
        state: "active",
        text: run.inputText,
        workspaceId: run.workspaceId,
      });
      await storage.put(RUNS_KEY, [...(await knownRuns()), run.id]);
    }
    // After the run is saved as active, so a run finishing at this moment keeps the token.
    await storage.put(SERVERS_KEY, input.mcpServers);
    const busy = await pi.busy();
    if (!busy) {
      await pi.setModel(input.agent.model);
      await pi.setInstructions(input.agent.instructions);
    }
    await pi.submit(
      await inputOf(
        { agentId: run.agentId, runId: run.id, workspaceId: run.workspaceId },
        run.inputText,
        input.inputFileIds,
        input.agent.model
      ),
      {
        operationId: run.id,
        whenBusy: busy ? "steer" : "followUp",
      }
    );
    follow(run.id);
  };

  // Two starts of one run at the same moment (a duplicate dispatch) take turns.
  let starting: Promise<unknown> = Promise.resolve();
  const start = async (input: CloudStart): Promise<void> => {
    const turn = starting.then(() => startOnce(input));
    starting = turn.catch(() => undefined);
    const modelIssue = await turn;
    if (modelIssue) {
      // A run that cannot start ends failed: a throw here would make the platform release it and retry it for ever.
      // The platform then offers the session's next run, which starts on this object, so this runs after the turn: inside it, that start would wait on this one.
      await completeRun(input.run.id, { error: modelIssue, status: "failed" });
    }
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

  /** Submits an active run again and works it. A no-op submit when Pi has the run covers a start that stopped before its submit. */
  const resumeRun = async (runId: string, run: StoredRun): Promise<void> => {
    if (!(await pi.busy())) {
      await pi.setModel(run.model);
      await pi.setInstructions(run.instructions);
    }
    await pi.submit(
      await inputOf(refOf(runId, run), run.text, run.fileIds, run.model),
      {
        operationId: runId,
        whenBusy: "followUp",
      }
    );
    follow(runId);
  };

  /** After a wake: works every run that has not finished. */
  const resume = async (): Promise<void> => {
    for (const runId of await knownRuns()) {
      // biome-ignore lint/performance/noAwaitInLoops: a handful of runs, read in order
      const run = await load(runId);
      if (run?.state === "active") {
        await resumeRun(runId, run);
      }
    }
  };

  /**
   * Called by the alarm every HEARTBEAT_MS. Heartbeats each active run whose
   * token is not yet too old, then works again each active run this object is
   * not following, so a run whose report or completion failed is tried again.
   * Resolves to whether any run is still active, so the caller knows whether to
   * keep the alarm. A failure on one run does not stop the others.
   */
  const beat = async (): Promise<boolean> => {
    const active: [string, StoredRun][] = [];
    for (const runId of await knownRuns()) {
      // biome-ignore lint/performance/noAwaitInLoops: a handful of runs, read in order
      const run = await load(runId);
      if (run?.state === "active") {
        active.push([runId, run]);
      }
    }
    await Promise.all(
      active.map(async ([runId, run]) => {
        if (now() - run.startedAt > RUN_TOKEN_MAX_AGE_MS) {
          return;
        }
        try {
          await heartbeat(runId);
        } catch (error) {
          // A run that the platform no longer runs refuses heartbeats, and says nothing new.
          if (!isRunGone(error)) {
            console.error(`PiRun: heartbeat for ${runId}: ${describe(error)}`);
          }
        }
      })
    );
    for (const [runId, run] of active) {
      if (!following.has(runId)) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: one run at a time, as on resume
          await resumeRun(runId, run);
        } catch (error) {
          console.error(`PiRun: resuming run ${runId}: ${describe(error)}`);
        }
      }
    }
    return active.length > 0;
  };

  return { beat, cancel, resume, start };
};

export type RunCore = ReturnType<typeof createRunCore>;
