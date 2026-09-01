import { createFileRoute } from "@tanstack/react-router";
import { ComputersApp } from "#/components/computers/computers-app";

export const Route = createFileRoute("/w/$workspaceSlug/computers/")({
  component: ComputersIndexRoute,
});

function ComputersIndexRoute() {
  return <ComputersApp hostId={null} />;
}
