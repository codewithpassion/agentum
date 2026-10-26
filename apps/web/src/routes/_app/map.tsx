import { createFileRoute } from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { MapPage } from "#/components/map/map-page.tsx";

export const Route = createFileRoute("/_app/map")({
  component: MapRoute,
});

function MapRoute() {
  return (
    <ReactFlowProvider>
      <MapPage />
    </ReactFlowProvider>
  );
}
