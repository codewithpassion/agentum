import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/settings/managed-agents")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/model-providers" });
  },
});
