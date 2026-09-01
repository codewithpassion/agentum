import { createFileRoute } from "@tanstack/react-router";
import { ComputersApp } from "#/components/computers/computers-app";

/** A host id is opaque and has no slashes, so a plain param is enough. */
export const Route = createFileRoute("/w/$workspaceSlug/computers/$hostId")({
  component: ComputerHostRoute,
});

function ComputerHostRoute() {
  const { hostId } = Route.useParams();

  return <ComputersApp hostId={hostId} />;
}
