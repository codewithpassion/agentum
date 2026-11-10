import { createFileRoute, redirect } from "@tanstack/react-router";
import { loadTask } from "#/components/task/load-task.ts";
import {
  threadOfTask,
  threadSearchSchema,
} from "#/components/task/thread-search.ts";

/** A task is a run, and a run lives in a thread: this sends the old URL to it. */
export const Route = createFileRoute("/_app/tasks/$runId")({
  validateSearch: (search) =>
    threadSearchSchema.pick({ tab: true }).parse(search),
  beforeLoad: async ({ location, params, search }) => {
    const task = await loadTask({ runId: params.runId });
    throw redirect({
      ...threadOfTask(task, search.tab),
      hash: location.hash || undefined,
      replace: true,
      to: "/threads/$sessionId",
    });
  },
  notFoundComponent: () => (
    <section className="mx-auto max-w-3xl">
      <h1 className="font-heading text-3xl text-foreground">Task not found</h1>
      <p className="mt-4 text-muted-foreground text-sm">
        This task does not exist, or you cannot see it.
      </p>
    </section>
  ),
});
