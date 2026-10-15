import { placeholderTool, READ_ONLY, WRITE_CREATE } from "./define";

export const agentTools = [
  placeholderTool({
    annotations: READ_ONLY,
    description:
      "Lists the agents in this workspace that the caller may message. Use the returned names as the agent argument of send_message and the session tools.",
    name: "list_agents",
    title: "List agents",
  }),
  placeholderTool({
    annotations: WRITE_CREATE,
    description:
      "Starts a run on an agent with the given text. Pass a requestId so a retry does not start a second run. Returns done with the answer if the run finishes within waitMs, or pending with a run id to check with get_run.",
    name: "send_message",
    title: "Send message",
  }),
  placeholderTool({
    annotations: READ_ONLY,
    description:
      "Returns the status and, once finished, the result of a run started by send_message.",
    name: "get_run",
    title: "Get run",
  }),
];
