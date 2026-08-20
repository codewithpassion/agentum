import { createFileRoute } from "@tanstack/react-router";
import { SkillsApp } from "#/components/skills/skills-app";

export interface SkillsIndexSearch {
  /** Set by "New skill"; writing a skill is a mode of this route. */
  new?: boolean;
}

export const Route = createFileRoute("/skills/")({
  component: SkillsIndexRoute,
  validateSearch: (search: Record<string, unknown>): SkillsIndexSearch => ({
    new: search.new === true || search.new === "true" ? true : undefined,
  }),
});

function SkillsIndexRoute() {
  const { new: creating } = Route.useSearch();

  return <SkillsApp creating={creating === true} slug={null} version={null} />;
}
