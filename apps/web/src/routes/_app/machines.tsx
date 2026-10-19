import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/machines")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/machines" });
  },
});
