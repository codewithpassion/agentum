import { createFileRoute } from "@tanstack/react-router";
import { WikiApp } from "#/components/wiki/wiki-app";

export interface WikiIndexSearch {
  /** Title of a page being written; set by the "New page" dialog. */
  new?: string;
}

export const Route = createFileRoute("/w/$workspaceSlug/wiki/")({
  component: WikiIndexRoute,
  validateSearch: (search: Record<string, unknown>): WikiIndexSearch => ({
    new: typeof search.new === "string" ? search.new : undefined,
  }),
});

function WikiIndexRoute() {
  const { new: draftTitle } = Route.useSearch();

  return <WikiApp draftTitle={draftTitle} edit={false} slug={null} />;
}
