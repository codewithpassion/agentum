import { createFileRoute, notFound } from "@tanstack/react-router";
import { loadTask } from "#/components/task/load-task.ts";
import { TaskPage } from "#/components/task/task-page.tsx";
import { threadSearchSchema } from "#/components/task/thread-search.ts";

export const Route = createFileRoute("/_app/threads/$sessionId")({
  validateSearch: (search) => threadSearchSchema.parse(search),
  // The tab is not a dependency: switching it must not reload the thread.
  loaderDeps: ({ search }) => ({ run: search.run }),
  loader: async ({ deps, params }) => {
    const task = await loadTask(
      deps.run === undefined
        ? { sessionId: params.sessionId }
        : { runId: deps.run }
    );
    // A run of another thread does not show under this thread's URL.
    if (task.session.id !== params.sessionId) {
      throw notFound();
    }
    return task;
  },
  notFoundComponent: ThreadNotFound,
  component: ThreadRoute,
});

function ThreadRoute() {
  const task = Route.useLoaderData();
  // A new latest run (a reply) starts the live state over.
  return <TaskPage initial={task} key={task.run.id} />;
}

function ThreadNotFound() {
  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="font-heading text-3xl text-foreground">
        Thread not found
      </h1>
      <p className="mt-4 text-muted-foreground text-sm">
        This thread does not exist, or you cannot see it.
      </p>
    </section>
  );
}
