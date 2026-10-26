// Runs one claimed run with Claude Code through the Agent SDK. The order is
// fixed: prepare the work directory, start `query()` in streaming-input mode
// with no MCP servers on its command line, hand the servers over the control
// channel with `setMcpServers`, and only then send the first user message. The
// run token reaches Claude Code through that control channel and nowhere else.
//
// The agent's skills and its part of the workspace library are copied in
// between preparing the work directory and the first message. The library
// changes go back while the run works (a watcher pushes an edit within
// seconds, a checkpoint every few minutes is the fallback) and once more
// after the process has exited, before the completion, because the run token
// stops working when the run ends. The relay's `library_changed` frames pull
// the changed files in while the run works. A run that was aborted sends
// nothing back: its edits stay on disk and go with the next run's sync.
//
// Files for the user go to the task folder inside the synced library, so they
// reach the library by sync and the daemon reads no attachment markers.
//
// Input files are downloaded between preparing the work directory and the first
// message. Heartbeats go on until the completion body is built, so a slow final
// library sync does not cost the run its lease.
//
// The local slot belongs to the caller. `finished` resolves after the
// completion was posted, and the completion is posted after the Claude Code
// process has exited, so a slot released on `finished` is really free.

import type {
  Options,
  Query,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { taskFolderPath } from "@repo/db/shared";
import { workspaceInstructions } from "@repo/protocol/attachments";
import {
  type ClaimResponse,
  type CompleteRequest,
  HEARTBEAT_SECONDS,
} from "@repo/protocol/machine";
import { createMasker, type Masker } from "@repo/protocol/masker";
import {
  maxTurnsOf,
  type RunStop,
  stopMessage,
} from "@repo/protocol/safeguards";
import { buildAgentEnv } from "./agent-env.ts";
import { createApprovalGate, gateOptions } from "./approvals.ts";
import type { Timers } from "./client.ts";
import type { CommandRunner } from "./command.ts";
import type { DaemonConfig } from "./config.ts";
import { createEventBatcher } from "./event-batcher.ts";
import type { FilesApi } from "./files-api.ts";
import type { LibraryApi } from "./library-api.ts";
import {
  createDaemonLibrarySync,
  type DaemonLibrarySync,
  fsLibraryWatcher,
  LIBRARY_DIR,
  type LibraryWatcher,
} from "./library-sync.ts";
import type { Logger } from "./log.ts";
import {
  normalizeMessage,
  type RunResult,
  sessionIdOf,
  summariseResult,
} from "./normalize.ts";
import type { RunApi } from "./run-api.ts";
import { fetchInputFiles, messageWithFiles } from "./run-files.ts";
import type { SkillsApi } from "./skills-api.ts";
import { syncSkills } from "./skills-sync.ts";
import { createWorkDisk } from "./work-disk.ts";
import { createWorkFiles, type WorkFiles } from "./work-files.ts";
import { prepareWorkDir, SCRATCH_DIR } from "./workdir.ts";

export type QueryFn = (params: {
  options?: Options;
  prompt: string | AsyncIterable<SDKUserMessage>;
}) => Query;

export type SpawnProcess = (options: SpawnOptions) => SpawnedProcess;

export interface ExecuteRunDeps {
  claim: ClaimResponse;
  config: Pick<
    DaemonConfig,
    "claudeBinary" | "credential" | "machineId" | "singleUser"
  >;
  /** Builds the run's HTTP client once the run token is known. */
  createApi: (masker: Masker) => RunApi;
  /** Builds the client for the file routes, which take the run token. */
  createFilesApi: (masker: Masker) => FilesApi;
  /** Builds the client for the library routes, which take the run token. The signal ends its requests when the run is aborted. */
  createLibraryApi: (masker: Masker, signal: AbortSignal) => LibraryApi;
  /** Builds the client for the skills routes, which take the run token. */
  createSkillsApi: (masker: Masker) => SkillsApi;
  /** The daemon user's home, for the work directory of a single_user machine. */
  daemonHome?: string;
  /** The daemon's own environment, filtered before it reaches Claude Code. */
  env: Record<string, string | undefined>;
  /** Builds the watcher of the library copy at `dir`. Defaults to `fs.watch`. */
  libraryWatcher?: (
    dir: string,
    onError: (error: unknown) => void
  ) => LibraryWatcher;
  log: Logger;
  queryFn: QueryFn;
  run: CommandRunner;
  /**
   * Builds the function that starts Claude Code, as hm-agent unless the
   * machine is single_user. `onStderr` receives what the process writes.
   */
  spawnProcessFor: (
    onStderr: (text: string) => void,
    preserveEnv: readonly string[]
  ) => SpawnProcess;
  timers: Timers;
}

/** The library folders the run's prompt names: copied in, with the conflict copies waiting in them. */
type LibraryCopy = NonNullable<ClaimResponse["library"]>;

export interface RunExecution {
  /** Stops the run. The completion is posted as `aborted` after the process exits. */
  abort: (reason: string) => void;
  /** Never rejects. */
  finished: Promise<void>;
  /** The library changed at these paths: pulls those under this run's roots. */
  libraryChanged: (paths: readonly string[]) => void;
}

const HEARTBEAT_MS = HEARTBEAT_SECONDS * 1000;
const MINUTE_MS = 60_000;
const LIBRARY_CHECKPOINT_MINUTES = 5;
/** How often a running run sends its library changes back. */
export const LIBRARY_CHECKPOINT_MS = LIBRARY_CHECKPOINT_MINUTES * MINUTE_MS;
/** How long Claude Code gets to leave after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 5000;
const STDERR_TAIL_CHARS = 500;
const CONFLICT = 409;

const statusOf = (error: unknown): number | undefined =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  typeof error.status === "number"
    ? error.status
    : undefined;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const budgetOf = (runtimeConfig: Record<string, unknown>) => {
  const value = runtimeConfig.maxBudgetUsd;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
};

/** The session to resume, only when this machine holds its transcript. */
const resumeOf = (
  claim: ClaimResponse,
  config: ExecuteRunDeps["config"]
): string | undefined =>
  claim.session.runtimeMachineId === config.machineId
    ? (claim.session.runtimeRef ?? undefined)
    : undefined;

const userMessage = (text: string): SDKUserMessage => ({
  message: { content: text, role: "user" },
  parent_tool_use_id: null,
  type: "user",
});

const completionOf = (
  result: RunResult | undefined,
  failure: string | undefined,
  sessionId: string | undefined,
  turnLimit: number
): CompleteRequest => {
  if (result && !result.isError) {
    return {
      runtimeRef: result.sessionId,
      status: "done",
      text: result.text,
      usage: result.usage,
    };
  }
  if (result?.turnLimitReached) {
    const stop: RunStop = { kind: "turn_limit", limit: turnLimit };
    return {
      error: stopMessage(stop),
      runtimeRef: result.sessionId,
      status: "failed",
      stop,
      usage: result.usage,
    };
  }
  if (result) {
    return {
      error: result.text,
      runtimeRef: result.sessionId,
      status: "failed",
      usage: result.usage,
    };
  }
  return {
    error: failure ?? "Claude Code ended without a result",
    status: "failed",
    ...(sessionId === undefined ? {} : { runtimeRef: sessionId }),
  };
};

export const executeRun = (deps: ExecuteRunDeps): RunExecution => {
  const { claim, config, log, timers } = deps;
  const agentSecrets = claim.env ?? {};
  const masker = createMasker({
    machine_credential: config.credential,
    run_token: claim.runToken,
    ...agentSecrets,
  });
  const api = deps.createApi(masker);
  const filesApi = deps.createFilesApi(masker);
  const skillsApi = deps.createSkillsApi(masker);
  const abortController = new AbortController();
  const runLog = (message: string) =>
    log.info(masker.mask(`run ${claim.run.id}: ${message}`));

  let abortReason: string | undefined;
  let child: SpawnedProcess | undefined;
  // True once the watcher pushes the agent's library edits within seconds.
  let liveSync = false;
  let stderrTail = "";

  const abort = (reason: string) => {
    if (abortReason !== undefined) {
      return;
    }
    abortReason = reason;
    runLog(`aborting: ${reason}`);
    abortController.abort();
  };

  const rememberStderr = (text: string) => {
    stderrTail = `${stderrTail}${text}`.slice(-STDERR_TAIL_CHARS);
  };

  // The exit is watched from the moment the process exists. A process killed by
  // a signal keeps `exitCode` null, and its `exit` event fires only once. A
  // process that could not start (no such file, no permission, no sudo) emits
  // `error` and never `exit`, so that ends the wait too.
  let exited: Promise<void> | undefined;
  let hasExited = false;
  const startProcess = deps.spawnProcessFor(
    rememberStderr,
    Object.keys(agentSecrets)
  );
  const spawnProcess = (options: SpawnOptions): SpawnedProcess => {
    const started = startProcess(options);
    child = started;
    exited = new Promise<void>((resolve) => {
      const gone = () => {
        hasExited = true;
        resolve();
      };
      started.once("exit", gone);
      started.once("error", gone);
    });
    return started;
  };

  /** Resolves once the process is gone; escalates to SIGKILL after a grace period. */
  const processExited = async (): Promise<void> => {
    const proc = child;
    if (proc === undefined || exited === undefined || hasExited) {
      return;
    }
    proc.kill("SIGTERM");
    const cancel = timers.after(
      KILL_GRACE_MS,
      () => {
        proc.kill("SIGKILL");
      },
      "kill"
    );
    await exited;
    cancel();
  };

  const batcher = createEventBatcher({
    onError: (error) => {
      runLog(`events failed: ${messageOf(error)}`);
      if (statusOf(error) === CONFLICT) {
        abort("the relay no longer accepts events for this run");
      }
    },
    send: api.events,
    timers,
  });

  const beat = () => {
    api.heartbeat().catch((error: unknown) => {
      if (statusOf(error) === CONFLICT) {
        abort("heartbeat rejected with 409");
      } else {
        runLog(`heartbeat failed: ${messageOf(error)}`);
      }
    });
  };

  const approvalGate = (rules: readonly string[]) =>
    createApprovalGate({
      api,
      log: runLog,
      rules,
      serverKeys: Object.keys(claim.mcpServers),
      signal: abortController.signal,
    });

  const buildOptions = (
    workDir: string,
    claudeBinary: string,
    library: LibraryCopy | undefined
  ): Options => {
    const budget = budgetOf(claim.agent.runtimeConfig);
    const resume = resumeOf(claim, config);
    // The daemon only collects attachments inside the work dir, so say so.
    // The task folder is a library path; the agent reaches it in the local copy.
    const taskFolder = library
      ? `${workDir}/${LIBRARY_DIR}/${library.taskFolder ?? taskFolderPath(claim.agent.slug, claim.run.id)}`
      : undefined;
    const files = workspaceInstructions({
      attachments: false,
      conflicts: library?.conflicts,
      home: workDir,
      homeIsLocal: true,
      library: library ? `${workDir}/${LIBRARY_DIR}` : null,
      liveSync,
      roots: library?.roots,
      scratch: { lasts: "run-start", path: `${workDir}/${SCRATCH_DIR}` },
      syncedPaths: library?.paths,
      taskFolder,
    });
    return {
      abortController,
      allowDangerouslySkipPermissions: true,
      cwd: workDir,
      // The agent's secrets join after the filter: DENY_PATTERN would drop
      // names that contain KEY or TOKEN, and these names often do.
      env: { ...buildAgentEnv(deps.env), ...agentSecrets },
      maxTurns: maxTurnsOf(claim.agent.runtimeConfig),
      model: claim.agent.model,
      pathToClaudeCodeExecutable: claudeBinary,
      permissionMode: "bypassPermissions",
      settingSources: ["project"],
      spawnClaudeCodeProcess: spawnProcess,
      strictMcpConfig: true,
      systemPrompt: {
        append: `${claim.instructions}\n\n${files}`,
        preset: "claude_code",
        type: "preset",
      },
      // Without a summary the thinking block arrives with empty text, and
      // normalize.ts drops it, so a machine task shows no thoughts.
      thinking: { display: "summarized", type: "adaptive" },
      // A claim without `toolRules` comes from a Worker that predates requests,
      // so such a run keeps its ungated bypassPermissions.
      ...(claim.toolRules === undefined
        ? {}
        : gateOptions(approvalGate(claim.toolRules))),
      ...(budget === undefined ? {} : { maxBudgetUsd: budget }),
      ...(resume === undefined ? {} : { resume }),
    };
  };

  let result: RunResult | undefined;
  let sessionId: string | undefined;

  const converse = async (
    options: Options,
    firstText: string
  ): Promise<void> => {
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let endInput: () => void = () => undefined;
    const turnOver = new Promise<void>((resolve) => {
      endInput = resolve;
    });
    abortController.signal.addEventListener("abort", () => {
      openGate();
      endInput();
    });

    async function* input(): AsyncGenerator<SDKUserMessage> {
      await gate;
      if (abortController.signal.aborted) {
        return;
      }
      yield userMessage(firstText);
      // Closing stdin after the answer lets Claude Code exit by itself.
      await turnOver;
    }

    const q = deps.queryFn({ options, prompt: input() });
    const handedOver = q
      .setMcpServers(claim.mcpServers)
      .then((outcome) => {
        const failed = Object.keys(outcome.errors);
        runLog(
          `mcp servers added: ${outcome.added.join(", ") || "none"}${
            failed.length > 0 ? `; failed: ${failed.join(", ")}` : ""
          }`
        );
      })
      .catch((error: unknown) => {
        runLog(`setMcpServers failed: ${messageOf(error)}`);
      })
      .finally(openGate);

    try {
      for await (const message of q) {
        sessionId = sessionIdOf(message) ?? sessionId;
        for (const event of normalizeMessage(message)) {
          batcher.push(event);
        }
        const summary = summariseResult(message);
        if (summary) {
          result = summary;
          endInput();
        }
      }
    } finally {
      // Close first: an abort during the handover may leave the control
      // request unanswered until the query is closed.
      q.close();
      await handedOver;
    }
  };

  let failure: string | undefined;
  let librarySync: DaemonLibrarySync | undefined;
  let cancelCheckpoint: () => void = () => undefined;

  /** Copies the agent's skills in. A failure is a warning: the run goes ahead without them. */
  const syncSkillsInto = async (files: WorkFiles): Promise<void> => {
    try {
      const count = await syncSkills({
        api: skillsApi,
        files,
        signal: abortController.signal,
      });
      runLog(`skills synced: ${count} files`);
    } catch (error) {
      if (abortReason !== undefined) {
        return;
      }
      runLog(
        `warning: skills sync failed, the run goes ahead without skills: ${messageOf(error)}`
      );
    }
  };

  /**
   * Copies the library folders the claim names into the work directory and
   * starts the watcher and the checkpoints. A failure is a warning: the run
   * goes ahead without a library copy, and the prompt does not mention one.
   */
  const syncLibraryInto = async (
    workDir: string
  ): Promise<LibraryCopy | undefined> => {
    const { library } = claim;
    if (library === undefined) {
      return;
    }
    const sync = createDaemonLibrarySync({
      api: deps.createLibraryApi(masker, abortController.signal),
      disk: createWorkDisk({
        run: deps.run,
        singleUser: config.singleUser,
        workDir,
      }),
      log: runLog,
      // A Worker that predates the library roots names only `paths`: the
      // agent's folder and the paths its config lists, all writable.
      roots:
        library.roots ??
        library.paths.map((path) => ({ mode: "write" as const, path })),
      runId: claim.run.id,
      watcher: (deps.libraryWatcher ?? fsLibraryWatcher)(
        `${workDir}/${LIBRARY_DIR}`,
        (error) => runLog(`warning: library watcher: ${messageOf(error)}`)
      ),
    });
    // Without a copy there is nothing to send back, and a machine whose sudo
    // rule lacks `find` would fail the same way again at the end of the run.
    if (!(await sync.syncIn())) {
      return;
    }
    librarySync = sync;
    liveSync = sync.startWatching();
    cancelCheckpoint = timers.every(
      LIBRARY_CHECKPOINT_MS,
      () => {
        sync.syncOut().catch(() => undefined);
      },
      "library-checkpoint"
    );
    return library;
  };

  const work = async (): Promise<void> => {
    if (config.claudeBinary === null) {
      failure =
        "No claude binary is configured for this machine. Enroll again with --claude <path>.";
      return;
    }
    const prepared = await prepareWorkDir({
      agentId: claim.run.agentId,
      daemonHome: deps.daemonHome,
      run: deps.run,
      singleUser: config.singleUser,
      workspaceId: claim.run.workspaceId,
    });
    const files = createWorkFiles({
      run: deps.run,
      singleUser: config.singleUser,
      workDir: prepared,
    });
    if (abortReason !== undefined) {
      return;
    }
    await syncSkillsInto(files);
    if (abortReason !== undefined) {
      return;
    }
    const libraryCopy = await syncLibraryInto(prepared);
    if (abortReason !== undefined) {
      return;
    }
    const inputPaths = await fetchInputFiles({
      api: filesApi,
      fileIds: claim.inputFileIds,
      files,
      signal: abortController.signal,
    });
    if (abortReason !== undefined) {
      return;
    }
    await converse(
      buildOptions(prepared, config.claudeBinary, libraryCopy),
      messageWithFiles(claim.run.inputText, inputPaths)
    );
  };

  /** The completion for a run that ended without an abort. */
  const completionBody = async (): Promise<CompleteRequest> => {
    const turnLimit = maxTurnsOf(claim.agent.runtimeConfig);
    // The process has exited, so nothing changes under library/ any more. The
    // run token still works: the run ends only with the completion below.
    await librarySync?.syncOut();
    return completionOf(result, failureDetail(), sessionId, turnLimit);
  };

  /** Why a run without a result failed, with what the process said last. */
  const failureDetail = (): string => {
    const reason = failure ?? "Claude Code ended without a result";
    const said = stderrTail.trim();
    return masker.mask(said === "" ? reason : `${reason}: ${said}`);
  };

  const run = async (): Promise<void> => {
    runLog("starting");
    batcher.start();
    const cancelBeat = timers.every(HEARTBEAT_MS, beat, "heartbeat");
    try {
      await work();
    } catch (error) {
      if (abortReason === undefined) {
        failure = messageOf(error);
      }
    } finally {
      batcher.stop();
      librarySync?.stopWatching();
      cancelCheckpoint();
    }
    await processExited();
    await batcher.flush();

    let body: CompleteRequest;
    try {
      body =
        abortReason === undefined
          ? await completionBody()
          : { status: "aborted" };
    } finally {
      cancelBeat();
    }
    try {
      await api.complete(body);
      runLog(`completed as ${body.status}`);
    } catch (error) {
      runLog(`completing failed: ${messageOf(error)}`);
    }
  };

  const finished = run().catch((error: unknown) => {
    runLog(`failed unexpectedly: ${messageOf(error)}`);
  });

  const libraryChanged = (paths: readonly string[]) => {
    if (abortReason === undefined) {
      librarySync?.pull(paths).catch(() => undefined);
    }
  };

  return { abort, finished, libraryChanged };
};
