import { createFileRoute, Outlet } from "@tanstack/react-router";
import { WorkspaceNotFound } from "#/components/tenant/workspace-not-found";
import { WorkspaceProvider } from "#/lib/workspace-context";

/**
 * Everything the app does happens inside one workspace, so the slug is a layout
 * route rather than a parameter each screen reads for itself: it resolves the
 * workspace once, hands its API client down, and is keyed by slug so switching
 * workspaces resets every piece of state below it instead of showing the last
 * tenant's data until a refetch lands.
 */
export const Route = createFileRoute("/w/$workspaceSlug")({
  component: WorkspaceLayout,
});

function WorkspaceLayout() {
  const { workspaceSlug } = Route.useParams();

  return (
    <WorkspaceProvider
      key={workspaceSlug}
      notFound={<WorkspaceNotFound slug={workspaceSlug} />}
      slug={workspaceSlug}
    >
      <Outlet />
    </WorkspaceProvider>
  );
}
