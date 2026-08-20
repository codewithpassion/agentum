import { createFileRoute } from "@tanstack/react-router";
import { ConnectorsApp } from "#/components/connectors/connectors-app";

/** A connector id is opaque and has no slashes, so a plain param is enough. */
export const Route = createFileRoute(
  "/w/$workspaceSlug/connectors/$connectorId"
)({
  component: ConnectorDetailRoute,
});

function ConnectorDetailRoute() {
  const { connectorId } = Route.useParams();

  return <ConnectorsApp connectorId={connectorId} />;
}
