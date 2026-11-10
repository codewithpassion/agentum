import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";
import type { EmptyTaskView, TaskView } from "#/integrations/trpc/types";

/** A task read by run id always has its run. */
export const withRun = (view: TaskView | EmptyTaskView): TaskView => {
  if (view.run === null) {
    throw new Error("The run has no thread yet.");
  }
  return view;
};

/**
 * Loads a task for a route: a signed-out caller goes to login, an unknown or
 * hidden one is not found. A session with no run yet loads without one.
 */
export function loadTask(input: { runId: string }): Promise<TaskView>;
export function loadTask(input: {
  sessionId: string;
}): Promise<TaskView | EmptyTaskView>;
export function loadTask(input: { runId: string } | { sessionId: string }) {
  return loadOrLogin(async () => {
    const view = await getTrpc().tasks.get.query(input);
    return "runId" in input ? withRun(view) : view;
  }, ["NOT_FOUND"]);
}
