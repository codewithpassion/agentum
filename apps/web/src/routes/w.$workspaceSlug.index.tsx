import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import {
  Workspace,
  type WorkspaceSelection,
} from "../components/workspace/workspace";

/**
 * The workspace is the app. Selection lives in the search params so a refresh
 * keeps you where you were - the params are only ever written by clicking.
 */
export const Route = createFileRoute("/w/$workspaceSlug/")({
  component: WorkspaceRoute,
  validateSearch: (search: Record<string, unknown>): WorkspaceSelection => ({
    agent: typeof search.agent === "string" ? search.agent : undefined,
    channel: typeof search.channel === "string" ? search.channel : undefined,
  }),
});

function WorkspaceRoute() {
  const selection = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const onSelect = useCallback(
    (next: WorkspaceSelection) => {
      navigate({ replace: true, search: next });
    },
    [navigate]
  );

  return <Workspace onSelect={onSelect} selection={selection} />;
}
