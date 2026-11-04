// The platform MCP tools' view of the services. One `McpPorts` per request,
// bound to the caller's principal: a tool never sees who is asking, and every
// call goes through the same service methods, and so the same `authorize()`,
// as the UI.
import { isPendingProposal } from "@repo/db/shared";
import type {
  AgentInfo,
  AutomationStatus,
  McpPorts,
  PostInfo,
  RoutineInfo,
  RunInfo,
  SessionInfo,
  ThreadInfo,
  TriggerChange,
  TriggerInfo,
} from "@repo/mcp/ports";
import { ToolError } from "@repo/mcp/result";
import { cloudEnvironmentOf } from "@repo/services/cloud/environment";
import { networkAccessOf } from "@repo/services/cloud/network";
import type { PostRecord, ThreadRecord } from "@repo/services/inbox";
import type { MachineRelayPort } from "@repo/services/machines/types";
import type { RoutineSummary } from "@repo/services/routines";
import type { RunSummary } from "@repo/services/runs/types";
import { placeholderOf } from "@repo/services/secrets/placeholders";
import type {
  SessionListItem,
  SessionTranscript,
} from "@repo/services/sessions";
import type {
  TriggerSummary,
  TriggerWithSecret,
} from "@repo/services/triggers";
import type { Principal } from "@repo/services/workspaces";
import type { ArtifactTestBrowser } from "../artifact-test/driver.ts";
import type { Services } from "../compose.ts";
import { runLibraryBash } from "../library-bash/run.ts";
import { bindLibraryOps } from "../library-env/library-ops.ts";
import { ownHostsOf } from "../web-fetch/guard.ts";
import {
  type RunFetcherDeps,
  runWebFetcher,
} from "../web-fetch/run-fetcher.ts";
import type { WebFetcher } from "../web-fetch/types.ts";
import { createAdminPorts } from "./admin-ports.ts";
import { createArtifactPorts } from "./artifact-ports.ts";
import { createBrowserPorts } from "./browser-ports.ts";
import { createComputerPorts } from "./computer-ports.ts";
import { createDeckPorts } from "./deck-ports";
import { guarded } from "./guarded.ts";
import { createLibraryPorts } from "./library-ports.ts";
import { createLivePorts } from "./live-ports";
import { createMailPorts } from "./mail-ports.ts";
import { createPeerPorts } from "./peer-ports.ts";
import { createQaPorts } from "./qa-ports.ts";
import { createSkillPorts } from "./skill-ports.ts";

const TITLE_MAX = 80;
/** What the Log keeps of a script that started `curl`. Each request has its own `network.request` event. */
export const NETWORK_SCRIPT_REDACTED =
  "[script redacted: made network requests]";

const toRunInfo = (run: RunSummary): RunInfo => ({
  agentId: run.agentId,
  answer: run.status === "done" ? run.resultText : null,
  error: run.error,
  runId: run.id,
  sessionId: run.sessionId,
  status: run.status,
});

const toThreadInfo = (thread: ThreadRecord): ThreadInfo => ({
  createdAt: thread.createdAt,
  id: thread.id,
  lastPostAt: thread.lastPostAt,
  title: thread.title,
});

const toPostInfo = (post: PostRecord): PostInfo => ({
  authorId: post.authorId,
  authorKind: post.authorKind,
  createdAt: post.createdAt,
  id: post.id,
  runId: post.runId,
  text: post.text,
});

const toSessionInfo = (item: SessionListItem): SessionInfo => ({
  createdAt: item.createdAt,
  id: item.id,
  lastRunAt: item.lastRunAt,
  origin: item.origin,
  status: item.status,
  title: item.title,
});

const toTranscriptSession = (transcript: SessionTranscript): SessionInfo => {
  const { latestRun, session } = transcript;
  const first = latestRun ? latestRun.inputText : "";
  return {
    createdAt: session.createdAt,
    id: session.id,
    lastRunAt: session.lastRunAt,
    origin: session.origin,
    status: latestRun?.status ?? null,
    title: first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX)}...` : first,
  };
};

/** Awaiting approval until a person approves a proposal, then paused or active. */
const statusOf = (row: {
  approvedAt: string | null;
  disabledAt: string | null;
  proposedByAgentId: string | null;
}): AutomationStatus => {
  if (isPendingProposal(row)) {
    return "awaiting_approval";
  }
  return row.disabledAt === null ? "active" : "paused";
};

const toRoutineInfo = (routine: RoutineSummary): RoutineInfo => ({
  agentId: routine.agentId,
  agentName: routine.agentName,
  cron: routine.cron,
  id: routine.id,
  lastFiredAt: routine.lastFiredAt,
  name: routine.name,
  nextRunAt: routine.nextRunAt,
  prompt: routine.prompt,
  status: statusOf(routine),
  timezone: routine.timezone,
});

const toTriggerInfo = (trigger: TriggerSummary): TriggerInfo => ({
  agentId: trigger.agentId,
  agentName: trigger.agentName,
  id: trigger.id,
  kind: trigger.kind,
  lastFiredAt: trigger.lastFiredAt,
  name: trigger.name,
  status: statusOf(trigger),
  tokenPrefix: trigger.tokenPrefix,
});

const toTriggerChange = (change: TriggerWithSecret): TriggerChange => ({
  secret: change.secret,
  trigger: toTriggerInfo(change.trigger),
});

/** The computer attached to a run's agent, or null. Revoked machines and ones with no computer role do not count. */
export const resolveRunComputer = async (
  services: Pick<Services, "agents" | "machines">,
  principal: Principal
): Promise<{ desktop: boolean; machineId: string } | null> => {
  if (principal.kind !== "run") {
    return null;
  }
  const agent = await services.agents.get(principal, principal.agentId);
  if (agent.computerMachineId === null) {
    return null;
  }
  const machine = (await services.machines.list(principal)).find(
    ({ id }) => id === agent.computerMachineId
  );
  if (
    !machine ||
    machine.status === "revoked" ||
    !machine.roles.includes("computer")
  ) {
    return null;
  }
  return {
    desktop: machine.computerCapabilities?.desktop === true,
    machineId: machine.id,
  };
};

/**
 * Whether the browser tools are on for the run. Every run has a browser unless
 * its agent's `runtimeConfig.browser` is `false` (the map's unplug, V7.4). A
 * user or key principal has no run to act as.
 */
export const resolveRunBrowser = async (
  services: Pick<Services, "agents">,
  principal: Principal
): Promise<boolean> => {
  if (principal.kind !== "run") {
    return false;
  }
  const agent = await services.agents.get(principal, principal.agentId);
  return agent.runtimeConfig.browser !== false;
};

export const createMcpPorts = ({
  artifactTestBrowser,
  computerMachineId,
  fetch,
  principal,
  publicBaseUrl,
  relay,
  requestHost,
  services,
  toolCallId,
}: {
  /** The browser `artifact_test` opens pages in. Without it the tool answers that the browser is unavailable. */
  artifactTestBrowser?: ArtifactTestBrowser;
  /** The machine of the run's computer (see `resolveRunComputer`). Without it, or without `relay`, the run has no computer tools. */
  computerMachineId?: string;
  /** Replaces the global `fetch` for `curl`. Tests inject a fake here. */
  fetch?: RunFetcherDeps["fetch"];
  principal: Principal;
  publicBaseUrl?: string;
  relay?: MachineRelayPort;
  requestHost?: string;
  services: Services;
  toolCallId?: string;
}): McpPorts => {
  const peers = createPeerPorts({ principal, services });

  /** The agent whose slug or id is `reference`, among those the caller can see. */
  const findAgent = async (reference: string): Promise<AgentInfo> => {
    const agents = await services.agents.list(principal);
    const found = agents.find(
      (agent) => agent.slug === reference || agent.id === reference
    );
    if (!found) {
      throw new ToolError(
        "not_found",
        `No agent "${reference}". Call list_agents for the names you can use.`
      );
    }
    return { id: found.id, name: found.name, slug: found.slug };
  };

  /** An agent id for `reference`, an id or a slug. Left out stays left out. */
  const agentIdOf = async (reference: string | undefined) =>
    reference === undefined ? undefined : (await findAgent(reference)).id;

  /**
   * The placeholder variables of the agent's granted env secrets, for an isolate
   * run. The value of each is its placeholder, never the secret. A lookup that
   * fails leaves the shell without variables.
   */
  const placeholderEnvOf = async (run: {
    agentId: string;
    workspaceId: string;
  }): Promise<Record<string, string> | undefined> => {
    try {
      const placeholders = await services.secrets.placeholdersFor(
        run.workspaceId,
        run.agentId
      );
      if (placeholders.length === 0) {
        return;
      }
      return Object.fromEntries(
        placeholders.map(({ name }) => [name, placeholderOf(name)])
      );
    } catch (error) {
      console.warn(
        "libraryBash: reading the secret placeholders failed",
        error instanceof Error ? error.name : "unknown error"
      );
    }
  };

  /**
   * What the shell of a run gets. The fetcher `curl` uses is made only for a run
   * whose agent has network access. A Linux VM agent always has network, so its
   * setting does not count. The placeholder variables go only to a cloud isolate
   * run with network access.
   */
  const shellFor = async (): Promise<{
    env?: Record<string, string>;
    web?: WebFetcher;
  }> => {
    if (principal.kind !== "run") {
      return {};
    }
    const agent = await services.agents.get(principal, principal.agentId);
    const inVm = cloudEnvironmentOf(agent.runtimeConfig) === "linux-vm";
    if (!(inVm || networkAccessOf(agent.runtimeConfig))) {
      return {};
    }
    const run = {
      agentId: principal.agentId,
      runId: principal.runId,
      workspaceId: principal.workspaceId,
    };
    const web = runWebFetcher({
      fetch,
      ownHosts: ownHostsOf(publicBaseUrl, requestHost ? [requestHost] : []),
      run,
      services,
      via: "curl",
    });
    if (agent.runtime !== "cloud" || inVm) {
      return { web };
    }
    return { env: await placeholderEnvOf(run), web };
  };

  return {
    ...(services.liveArtifacts
      ? {
          ...createDeckPorts({
            principal,
            publicBaseUrl,
            services,
            toolCallId,
          }),
          live: createLivePorts({
            principal,
            publicBaseUrl,
            services,
            toolCallId,
          }),
        }
      : {}),
    ...createLibraryPorts({ principal, services }),
    // The route offers the tools only to a key whose access allows them.
    ...(principal.kind === "user" && principal.apiKey
      ? { admin: createAdminPorts({ principal, services }) }
      : {}),
    ...createSkillPorts({ findAgent, principal, services }),
    // The Q&A board is shared: any principal reads it, the service decides who writes.
    qa: createQaPorts({ principal, services }),
    // Only a run has a mailbox of its own. The route turns the tools on when it is active.
    ...(principal.kind === "run"
      ? { mail: createMailPorts({ principal, services }) }
      : {}),
    ...(principal.kind === "run" || principal.kind === "user"
      ? {
          artifacts: createArtifactPorts({
            principal,
            publicBaseUrl,
            services,
            testBrowser: artifactTestBrowser,
          }),
        }
      : {}),
    // The browser is every run's. The computer is the one attached to its agent.
    ...(principal.kind === "run"
      ? {
          browser: createBrowserPorts({ principal, services }),
          ...(relay && computerMachineId
            ? {
                computer: createComputerPorts({
                  machineId: computerMachineId,
                  principal,
                  relay,
                  services,
                }),
              }
            : {}),
        }
      : {}),

    cancelRun: ({ runId }) =>
      guarded(async () => {
        await services.runs.cancelRun(principal, runId);
        return toRunInfo(await services.runs.getRun(principal, runId));
      }),

    createRoutine: ({ agentId, ...input }) =>
      guarded(async () =>
        toRoutineInfo(
          await services.routines.create(principal, {
            ...input,
            agentId: (await findAgent(agentId)).id,
          })
        )
      ),

    createTrigger: ({ agentId, name }) =>
      guarded(async () =>
        toTriggerChange(
          await services.triggers.create(principal, {
            agentId: (await findAgent(agentId)).id,
            name,
          })
        )
      ),

    deleteRoutine: ({ routineId }) =>
      guarded(() => services.routines.remove(principal, routineId)),

    deleteTrigger: ({ triggerId }) =>
      guarded(async () => {
        await services.triggers.revoke(principal, triggerId);
      }),

    getRun: ({ runId }) =>
      peers.ownsRun(runId)
        ? peers.getRun(runId)
        : guarded(async () =>
            toRunInfo(await services.runs.getRun(principal, runId))
          ),

    inboxList: () =>
      guarded(async () =>
        (await services.inbox.listThreads(principal)).map(toThreadInfo)
      ),

    inboxPost: ({ text, threadId }) =>
      guarded(async () => {
        const posted = await services.inbox.post(principal, { text, threadId });
        return { post: toPostInfo(posted.post), runs: posted.runs };
      }),

    inboxRead: ({ threadId }) =>
      guarded(async () => {
        const view = await services.inbox.readThread(principal, { threadId });
        return {
          posts: view.posts.map(toPostInfo),
          thread: toThreadInfo(view.thread),
        };
      }),
    libraryBash: ({ script }) =>
      guarded(async () => {
        const { library } = services;
        let usedNetwork = false;
        const { env, web } = await shellFor();
        const result = await runLibraryBash({
          env,
          onCurl: () => {
            usedNetwork = true;
          },
          ops: bindLibraryOps(library, principal),
          script,
          web,
        });
        await library.recordCommand(principal, {
          exitCode: result.exitCode,
          // A script that used the network may hold a token anywhere in its text
          // (a variable, a file, a pipe), and spelling cannot be checked, so the
          // Log keeps the request events instead of the script.
          script: usedNetwork ? NETWORK_SCRIPT_REDACTED : script,
          storageCalls: result.storageCalls,
          wallMs: result.wallMs,
        });
        return result;
      }),

    listAgents: () =>
      guarded(async () => [
        ...(await services.agents.list(principal)).map((agent) => ({
          id: agent.id,
          name: agent.name,
          slug: agent.slug,
        })),
        // Only a run has peers, so every other caller gets the local list alone.
        ...(await peers.list()),
      ]),

    listRoutines: ({ agentId }) =>
      guarded(async () =>
        (
          await services.routines.list(principal, {
            agentId: await agentIdOf(agentId),
          })
        ).map(toRoutineInfo)
      ),

    listSessions: ({ agent }) =>
      guarded(async () => {
        const target = await findAgent(agent);
        const sessions = await services.sessions.list(principal, {
          agentId: target.id,
        });
        return sessions.map(toSessionInfo);
      }),

    listTriggers: ({ agentId }) =>
      guarded(async () =>
        (
          await services.triggers.list(principal, {
            agentId: await agentIdOf(agentId),
          })
        )
          // A revoked trigger is gone; the UI keeps it only as history.
          .filter((trigger) => trigger.revokedAt === null)
          .map(toTriggerInfo)
      ),

    readSession: ({ sessionId }) =>
      guarded(async () => {
        const transcript = await services.sessions.transcript(
          principal,
          sessionId
        );
        return {
          entries: transcript.entries.map((entry) => ({
            createdAt: entry.createdAt,
            payload: entry.payload,
            type: entry.type,
          })),
          session: toTranscriptSession(transcript),
        };
      }),

    searchSessions: ({ agent, query }) =>
      guarded(async () => {
        const target = await findAgent(agent);
        const hits = await services.sessions.search(principal, {
          agentId: target.id,
          query,
        });
        return hits.map((hit) => ({
          passages: hit.passages,
          session: toSessionInfo(hit.session),
        }));
      }),

    sendMessage: ({ agent, requestId, text, waitMs }) =>
      peers.ownsAgent(agent)
        ? peers.send({ agent, requestId, text, waitMs })
        : guarded(async () => {
            const target = await findAgent(agent);
            const started = await services.runs.startRun(principal, {
              agentId: target.id,
              input: { text },
              requestId,
              session: { origin: "mcp" },
            });
            const run =
              waitMs > 0
                ? await services.runs.waitForRun(
                    principal,
                    started.runId,
                    waitMs
                  )
                : await services.runs.getRun(principal, started.runId);
            return toRunInfo(run);
          }),

    setRoutineEnabled: ({ enabled, routineId }) =>
      guarded(async () =>
        toRoutineInfo(
          await services.routines.setEnabled(principal, { enabled, routineId })
        )
      ),

    setTriggerEnabled: ({ enabled, triggerId }) =>
      guarded(async () =>
        toTriggerChange(
          await services.triggers.setEnabled(principal, { enabled, triggerId })
        )
      ),

    slackDestinations: () =>
      guarded(() => services.slackSend.destinations(principal)),

    slackHistory: (input) =>
      guarded(() =>
        services.slackHistory.history(principal, {
          channel: input.channel,
          cursor: input.cursor,
          limit: input.limit,
          since: input.since,
          threadTs: input.thread_ts,
          until: input.until,
        })
      ),

    slackSearch: (input) =>
      guarded(() => services.slackHistory.search(principal, input)),

    slackSend: ({ text, thread_ts, to }) =>
      guarded(() =>
        services.slackSend.send(principal, { text, threadTs: thread_ts, to })
      ),
  };
};
