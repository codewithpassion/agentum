import { createFileRoute } from "@tanstack/react-router";
import { ConnectorsApp } from "#/components/connectors/connectors-app";

export const Route = createFileRoute("/connectors/")({
  component: ConnectorsIndexRoute,
});

function ConnectorsIndexRoute() {
  return <ConnectorsApp connectorId={null} />;
}
