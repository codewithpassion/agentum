import { placeholderTool, READ_ONLY, WRITE_CREATE } from "./define";

export const inboxTools = [
  placeholderTool({
    annotations: READ_ONLY,
    description:
      "Lists the threads in the workspace inbox, most recent first. Use the returned thread ids with inbox_read.",
    name: "inbox_list",
    title: "List inbox threads",
  }),
  placeholderTool({
    annotations: READ_ONLY,
    description:
      "Returns one workspace inbox thread with its messages in order.",
    name: "inbox_read",
    title: "Read inbox thread",
  }),
  placeholderTool({
    annotations: WRITE_CREATE,
    description:
      "Posts a new message to a workspace inbox thread. Use inbox_read first to see what it answers.",
    name: "inbox_post",
    title: "Post to inbox thread",
  }),
];
