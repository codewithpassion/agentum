import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/map")({
  component: MapPage,
});

function MapPage() {
  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="font-heading text-3xl text-foreground">Map</h1>
      <p className="mt-4 text-muted-foreground text-sm">Map comes in V7.</p>
    </section>
  );
}
