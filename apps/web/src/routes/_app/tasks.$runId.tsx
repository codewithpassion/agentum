import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { TaskPage } from "#/components/task/task-page.tsx";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/_app/tasks/$runId")({
  loader: async ({ params }) => {
    try {
      return await getTrpc().tasks.get.query({ runId: params.runId });
    } catch (error) {
      if (
        error instanceof TRPCClientError &&
        error.data?.code === "UNAUTHORIZED"
      ) {
        throw redirect({ to: "/login" });
      }
      if (
        error instanceof TRPCClientError &&
        error.data?.code === "NOT_FOUND"
      ) {
        throw notFound();
      }
      throw error;
    }
  },
  notFoundComponent: TaskNotFound,
  component: TaskRoute,
});

function TaskRoute() {
  const task = Route.useLoaderData();
  // A new run id is a new task, so the live state starts over.
  return <TaskPage initial={task} key={task.run.id} />;
}

function TaskNotFound() {
  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="font-heading text-3xl text-foreground">Task not found</h1>
      <p className="mt-4 text-muted-foreground text-sm">
        This task does not exist, or you cannot see it.
      </p>
    </section>
  );
}
