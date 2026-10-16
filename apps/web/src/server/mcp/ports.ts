// The platform MCP tools' view of the services. One `McpPorts` per request,
// bound to the caller's principal: a tool never sees who is asking, and every
// call goes through the same service methods, and so the same `authorize()`,
// as the UI.
import type {
  AgentInfo,
  McpPorts,
  RunInfo,
  SessionInfo,
} from "@repo/mcp/ports";
import { ToolError } from "@repo/mcp/result";
import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import type { RunSummary } from "@repo/services/runs/types";
import type {
  SessionListItem,
  SessionTranscript,
} from "@repo/services/sessions";
import type { Principal } from "@repo/services/workspaces";
import type { Services } from "../compose.ts";

const TITLE_MAX = 80;

/** The service errors an agent can act on, as tool errors. Anything else passes through. */
const toToolError = (error: unknown): unknown => {
  if (isForbiddenError(error)) {
    return new ToolError(
      "forbidden",
      "This credential may not do that. A read-only API key cannot send messages."
    );
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

  return {
    getRun: ({ runId }) =>
      guarded(async () =>
        toRunInfo(await services.runs.getRun(principal, runId))
      ),

    listAgents: () =>
      guarded(async () =>
        (await services.agents.list(principal)).map((agent) => ({
          id: agent.id,
          name: agent.name,
          slug: agent.slug,
        }))
      ),

    listSessions: ({ agent }) =>
      guarded(async () => {
        const target = await findAgent(agent);
        const sessions = await services.sessions.list(principal, {
          agentId: target.id,
        });
        return sessions.map(toSessionInfo);
      }),

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
  };
};
