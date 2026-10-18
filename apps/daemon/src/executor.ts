// Runs one claimed run with Claude Code through the Agent SDK. The order is
// fixed: prepare the work directory, start `query()` in streaming-input mode
// with no MCP servers on its command line, hand the servers over the control
// channel with `setMcpServers`, and only then send the first user message. The
// run token reaches Claude Code through that control channel and nowhere else.
//
// Input files are downloaded between preparing the work directory and the first
// message. Output files are uploaded after the process has exited and before
// the completion; heartbeats go on until the completion body is built, so a slow
// upload does not cost the run its lease.
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
import { workspaceInstructions } from "@repo/protocol/attachments";
import {
  type ClaimResponse,
  type CompleteRequest,
  HEARTBEAT_SECONDS,
} from "@repo/protocol/machine";
import { createMasker, type Masker } from "@repo/protocol/masker";
import { buildAgentEnv } from "./agent-env.ts";
import type { Timers } from "./client.ts";
import type { CommandRunner } from "./command.ts";
import type { DaemonConfig } from "./config.ts";
import { createEventBatcher } from "./event-batcher.ts";
import type { FilesApi } from "./files-api.ts";
import type { Logger } from "./log.ts";
import {
  normalizeMessage,
  type RunResult,
  sessionIdOf,
  summariseResult,
} from "./normalize.ts";
import type { RunApi } from "./run-api.ts";
import {
  fetchInputFiles,
  messageWithFiles,
  uploadOutputs,
} from "./run-files.ts";
import type { SkillsApi } from "./skills-api.ts";
import { syncSkills } from "./skills-sync.ts";
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
  /** Builds the client for the skills routes, which take the run token. */
  createSkillsApi: (masker: Masker) => SkillsApi;
  /** The daemon user's home, for the work directory of a single_user machine. */
  daemonHome?: string;
  /** The daemon's own environment, filtered before it reaches Claude Code. */
  env: Record<string, string | undefined>;
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

export interface RunExecution {
  /** Stops the run. The completion is posted as `aborted` after the process exits. */
  abort: (reason: string) => void;
  /** Never rejects. */
  finished: Promise<void>;
}

const HEARTBEAT_MS = HEARTBEAT_SECONDS * 1000;
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
  fileIds: string[] = []
): CompleteRequest => {
  if (result && !result.isError) {
    return {
      runtimeRef: result.sessionId,
      status: "done",
      text: result.text,
      usage: result.usage,
      ...(fileIds.length > 0 ? { fileIds } : {}),
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

  const buildOptions = (workDir: string, claudeBinary: string): Options => {
    const budget = budgetOf(claim.agent.runtimeConfig);
    const resume = resumeOf(claim, config);
    // The daemon only collects attachments inside the work dir, so say so.
    const files = `${workspaceInstructions({
      home: workDir,
      homeIsLocal: true,
      library: null,
      scratch: { lasts: "run-start", path: `${workDir}/${SCRATCH_DIR}` },
    })}\nA file can only be attached from inside ${workDir}.`;
    return {
      abortController,
      allowDangerouslySkipPermissions: true,
      cwd: workDir,
      // The agent's secrets join after the filter: DENY_PATTERN would drop
      // names that contain KEY or TOKEN, and these names often do.
      env: { ...buildAgentEnv(deps.env), ...agentSecrets },
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
  let preparedFiles: WorkFiles | undefined;

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
    preparedFiles = files;
    if (abortReason !== undefined) {
      return;
    }
    await syncSkillsInto(files);
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
      buildOptions(prepared, config.claudeBinary),
      messageWithFiles(claim.run.inputText, inputPaths)
    );
  };

  /** The completion for a run that ended without an abort. */
  const completionBody = async (): Promise<CompleteRequest> => {
    if (result === undefined || result.isError || preparedFiles === undefined) {
      return completionOf(result, failureDetail(), sessionId);
    }
    try {
      const outputs = await uploadOutputs({
        api: filesApi,
        files: preparedFiles,
        log: runLog,
        signal: abortController.signal,
        text: result.text,
      });
      return completionOf(
        { ...result, text: outputs.text },
        undefined,
        sessionId,
        outputs.fileIds
      );
    } catch (error) {
      if (abortReason === undefined) {
        runLog(`attachments failed: ${messageOf(error)}`);
        return completionOf(result, undefined, sessionId);
      }
      return { status: "aborted" };
    }
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

  return { abort, finished };
};
