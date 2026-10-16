import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/agents/new")({
  component: () => <p>New agent.</p>,
});
