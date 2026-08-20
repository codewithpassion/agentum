import { createFileRoute } from "@tanstack/react-router";
import { WikiApp } from "#/components/wiki/wiki-app";

export interface WikiPageSearch {
  /** Set by the Edit button; the editor is a mode of the page, not a route. */
  edit?: boolean;
  /** Carried by a link to a page that does not exist yet, to prefill its title. */
  title?: string;
}

/** A splat, not `$slug`: a page's address is a path, so it can contain "/". */
export const Route = createFileRoute("/wiki/$")({
  component: WikiPageRoute,
  validateSearch: (search: Record<string, unknown>): WikiPageSearch => ({
    edit: search.edit === true || search.edit === "true" ? true : undefined,
    title: typeof search.title === "string" ? search.title : undefined,
  }),
});

function WikiPageRoute() {
  const { _splat } = Route.useParams();
  const { edit, title } = Route.useSearch();

  return (
    <WikiApp edit={edit === true} prefillTitle={title} slug={_splat ?? null} />
  );
}
