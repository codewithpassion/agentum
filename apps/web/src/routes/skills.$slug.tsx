import { createFileRoute } from "@tanstack/react-router";
import { SkillsApp } from "#/components/skills/skills-app";

export interface SkillPageSearch {
  /** Set by the Edit button; publishing a version is a mode of the page. */
  edit?: boolean;
  /** An older version to read; absent means the latest. */
  version?: number;
}

/** A slug is lowercase kebab with no slashes, so a plain param is enough. */
export const Route = createFileRoute("/skills/$slug")({
  component: SkillPageRoute,
  validateSearch: (search: Record<string, unknown>): SkillPageSearch => ({
    edit: search.edit === true || search.edit === "true" ? true : undefined,
    version: Number.isFinite(Number(search.version))
      ? Number(search.version)
      : undefined,
  }),
});

function SkillPageRoute() {
  const { slug } = Route.useParams();
  const { edit, version } = Route.useSearch();

  return (
    <SkillsApp editing={edit === true} slug={slug} version={version ?? null} />
  );
}
