import { createFileRoute, redirect } from "@tanstack/react-router";

/** Routines are jobs now: this sends the old URL to the Jobs page. */
export const Route = createFileRoute("/_app/routines")({
  beforeLoad: () => {
    throw redirect({ replace: true, to: "/jobs" });
  },
});
