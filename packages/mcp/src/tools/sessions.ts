import { placeholderTool, READ_ONLY } from "./define";

export const sessionTools = [
  placeholderTool({
    annotations: READ_ONLY,
    description:
      "Lists the sessions of one agent, newest first. Use the returned session ids with read_session.",
    name: "list_sessions",
    title: "List sessions",
  }),
  placeholderTool({
    annotations: READ_ONLY,
    description:
      "Returns the transcript of one session of an agent: its messages and tool calls in order.",
    name: "read_session",
    title: "Read session",
  }),
  placeholderTool({
    annotations: READ_ONLY,
    description:
      "Searches the transcripts of an agent's sessions for text and returns the sessions that match, with the matching passages.",
    name: "search_sessions",
    title: "Search sessions",
  }),
];
