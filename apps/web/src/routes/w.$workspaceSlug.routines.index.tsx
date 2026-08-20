import { createFileRoute } from "@tanstack/react-router";
import { RoutinesApp } from "#/components/routines/routines-app";

export interface RoutinesIndexSearch {
  /** Set by "New routine"; writing one is a mode of this route. */
  new?: boolean;
}

export const Route = createFileRoute("/w/$workspaceSlug/routines/")({
  component: RoutinesIndexRoute,
  validateSearch: (search: Record<string, unknown>): RoutinesIndexSearch => ({
    new: search.new === true || search.new === "true" ? true : undefined,
  }),
});

function RoutinesIndexRoute() {
  const { new: creating } = Route.useSearch();

  return <RoutinesApp creating={creating === true} routineId={null} />;
}
