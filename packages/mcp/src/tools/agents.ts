import { z } from "zod";
import { type McpPorts, type RunInfo, SEND_WAIT_MAX_MS } from "../ports";
import type { ToolPayload } from "../result";
import {
  defineTool,
  READ_ONLY,
  type ToolDefinition,
  WRITE_CREATE,
} from "./define";

type RunState = "done" | "failed" | "pending";

const stateOf = (status: string): RunState => {
  if (status === "done") {
    return "done";
  }
  if (
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  ) {
    return "failed";
  }
  return "pending";
};

const runText = (run: RunInfo, state: RunState): string => {
  if (state === "done") {
    return run.answer ?? "";
  }
  if (state === "failed") {
    return run.error ?? `Run ${run.runId} is ${run.status}.`;
  }
  return `Run ${run.runId} is ${run.status}. Check it with get_run.`;
};

/** The shape send_message and get_run both answer with. */
const runPayload = (run: RunInfo): ToolPayload => {
  const state = stateOf(run.status);
  return {
    data: {
      answer: run.answer ?? undefined,
      error: run.error ?? undefined,
      runId: run.runId,
      sessionId: run.sessionId,
      state,
      status: run.status,
    },
    text: runText(run, state),
  };
};

export const agentTools = (ports: McpPorts): ToolDefinition[] => [
  defineTool({
    annotations: READ_ONLY,
    description:
      "Lists the agents in this workspace that the caller may message. Use the returned slugs as the agent argument of send_message and the session tools.",
    inputSchema: z.strictObject({}),
    name: "list_agents",
    run: async () => {
      const agents = (await ports.listAgents()).map(({ id, name, slug }) => ({
        id,
        name,
        slug,
      }));
      return {
        data: { agents },
        text:
          agents.map((agent) => `${agent.slug}: ${agent.name}`).join("\n") ||
          "No agents.",
      };
    },
    title: "List agents",
  }),
  defineTool({
    annotations: WRITE_CREATE,
    description:
      "Starts a run on an agent with the given text. Pass a requestId so a retry does not start a second run. Returns state done with the answer if the run finishes within waitMs, or state pending with a run id to check with get_run.",
    inputSchema: z.strictObject({
      agent: z
        .string()
        .min(1)
        .max(200)
        .describe("The agent's slug, as list_agents returns it."),
      requestId: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "A key you choose for this message. A retry with the same key returns the first run instead of starting another."
        ),
      text: z
        .string()
        .min(1)
        .max(100_000)
        .describe("The message to send to the agent."),
      waitMs: z
        .number()
        .int()
        .min(0)
        .max(SEND_WAIT_MAX_MS)
        .default(0)
        .describe(
          "How many milliseconds to wait for the run to finish, up to 25000. Zero returns at once."
        ),
    }),
    name: "send_message",
    run: async (input) => runPayload(await ports.sendMessage(input)),
    title: "Send message",
  }),
  defineTool({
    annotations: READ_ONLY,
    description:
      "Returns the state and, once finished, the answer of a run started by send_message. State is done, failed or pending.",
    inputSchema: z.strictObject({
      runId: z
        .string()
        .min(1)
        .max(200)
        .describe("The runId that send_message returned."),
    }),
    name: "get_run",
    run: async (input) => runPayload(await ports.getRun(input)),
    title: "Get run",
  }),
];
