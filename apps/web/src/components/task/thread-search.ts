import { z } from "zod";
import { runSearch } from "./thread-runs.tsx";

/**
 * The search of a thread's URL: the run in view (none means the latest) and
 * the open tab (none means the conversation). A bad value reads as none.
 */
export const threadSearchSchema = z.object({
  run: z.string().min(1).max(200).optional().catch(undefined),
  tab: z.enum(["files", "log", "mail", "computer"]).optional().catch(undefined),
});

export type ThreadSearch = z.infer<typeof threadSearchSchema>;

/** Where `/tasks/<runId>` goes: its thread, with `?run=` unless the run is the latest. */
export const threadOfTask = (
  task: {
    otherRuns: readonly { id: string }[];
    run: { id: string };
    session: { id: string };
  },
  tab: ThreadSearch["tab"]
): { params: { sessionId: string }; search: ThreadSearch } => {
  const latest = task.otherRuns.reduce(
    (newest, run) => (run.id > newest ? run.id : newest),
    task.run.id
  );
  return {
    params: { sessionId: task.session.id },
    search: { ...runSearch(task.run.id, latest), ...(tab ? { tab } : {}) },
  };
};
