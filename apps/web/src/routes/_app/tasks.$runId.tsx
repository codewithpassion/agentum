import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/tasks/$runId")({
  component: TaskPage,
});

// Stub. V2.11 fills it.
function TaskPage() {
  const { runId } = Route.useParams();
  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="font-heading text-3xl text-foreground">Task</h1>
      <p className="mt-4 text-muted-foreground text-sm">{runId}</p>
    </section>
  );
}
