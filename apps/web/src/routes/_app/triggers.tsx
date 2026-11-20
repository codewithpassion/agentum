import { createFileRoute, redirect } from "@tanstack/react-router";

/** Triggers are jobs now: this sends the old URL to the Jobs page. */
export const Route = createFileRoute("/_app/triggers")({
  beforeLoad: () => {
    throw redirect({ replace: true, to: "/jobs" });
  },
});
