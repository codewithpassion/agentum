import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/desk")({
  component: Desk,
});

// Stub. V2.10 fills it.
function Desk() {
  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="font-heading text-3xl text-foreground">Desk</h1>
      <p className="mt-4 text-muted-foreground text-sm">
        Work that needs you will show up here.
      </p>
    </section>
  );
}
