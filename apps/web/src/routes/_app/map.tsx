import { createFileRoute } from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { MAP_HEADING } from "#/components/map/map-heading.ts";
import { MapPage } from "#/components/map/map-page.tsx";

export const PAGE_HEADING = MAP_HEADING;

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
