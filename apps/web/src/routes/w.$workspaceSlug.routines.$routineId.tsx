import { createFileRoute } from "@tanstack/react-router";
import { RoutinesApp } from "#/components/routines/routines-app";

export interface RoutinePageSearch {
  /** Set by the Edit button; editing is a mode of the page. */
  edit?: boolean;
}

/** A routine id is opaque and has no slashes, so a plain param is enough. */
export const Route = createFileRoute("/w/$workspaceSlug/routines/$routineId")({
  component: RoutinePageRoute,
  validateSearch: (search: Record<string, unknown>): RoutinePageSearch => ({
    edit: search.edit === true || search.edit === "true" ? true : undefined,
  }),
});

function RoutinePageRoute() {
  const { routineId } = Route.useParams();
  const { edit } = Route.useSearch();

  return <RoutinesApp editing={edit === true} routineId={routineId} />;
}
