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
import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import type { PostRecord, ThreadRecord } from "@repo/services/inbox";
import type { RoutineSummary } from "@repo/services/routines";
import type { RunSummary } from "@repo/services/runs/types";
import type {
  SessionListItem,
  SessionTranscript,
} from "@repo/services/sessions";
import type {
  TriggerSummary,
  TriggerWithSecret,
} from "@repo/services/triggers";
import type { Principal } from "@repo/services/workspaces";
import type { Services } from "../compose.ts";
import { runLibraryBash } from "../library-bash/run.ts";
import { bindLibraryOps } from "../library-env/library-ops.ts";

const TITLE_MAX = 80;

/** The service errors an agent can act on, as tool errors. Anything else passes through. */
const toToolError = (error: unknown): unknown => {
  if (isForbiddenError(error)) {
    return new ToolError("forbidden", "This credential may not do that.");
  }
  if (isServiceError(error)) {
    const code = error.code === "invalid" ? "validation" : error.code;
    return new ToolError(code, error.message);
  }
  return error;
};

/** Runs `work`, turning the errors a tool may show into `ToolError`. */
const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw toToolError(error);
  }
};

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
  lastFiredAt: trigger.lastFiredAt,
  name: trigger.name,
  status: statusOf(trigger),
  tokenPrefix: trigger.tokenPrefix,
});

const toTriggerChange = (change: TriggerWithSecret): TriggerChange => ({
  secret: change.secret,
  trigger: toTriggerInfo(change.trigger),
});

export const createMcpPorts = ({
  principal,
  services,
}: {
  principal: Principal;
  services: Services;
}): McpPorts => {
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

  return {
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
      guarded(async () =>
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
        const result = await runLibraryBash({
          ops: bindLibraryOps(library, principal),
          script,
        });
        await library.recordCommand(principal, {
          exitCode: result.exitCode,
          script,
          storageCalls: result.storageCalls,
          wallMs: result.wallMs,
        });
        return result;
      }),

    listAgents: () =>
      guarded(async () =>
        (await services.agents.list(principal)).map((agent) => ({
          id: agent.id,
          name: agent.name,
          slug: agent.slug,
        }))
      ),

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
      guarded(async () => {
        const target = await findAgent(agent);
        const started = await services.runs.startRun(principal, {
          agentId: target.id,
          input: { text },
          requestId,
          session: { origin: "mcp" },
        });
        const run =
          waitMs > 0
            ? await services.runs.waitForRun(principal, started.runId, waitMs)
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
  };
};
