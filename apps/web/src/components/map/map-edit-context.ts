import { createContext, useContext } from "react";
import type { MapTool } from "./editor-logic.ts";

/** What the nodes and wires need from the Editor mode, so it need not travel in every node's data. */
export interface MapEditApi {
  /** True in Editor mode. */
  editor: boolean;
  /** A wire's delete button was pressed. `edgeId` is the xyflow edge id. */
  onDeleteWire: (edgeId: string) => void;
  /** A tool was dropped on an agent's node. */
  onPlug: (agentId: string, tool: MapTool) => void;
  /** A port chip's remove button was pressed. */
  onUnplug: (agentId: string, tool: MapTool) => void;
}

const READ_ONLY: MapEditApi = {
  editor: false,
  onDeleteWire: () => undefined,
  onPlug: () => undefined,
  onUnplug: () => undefined,
};

export const MapEditContext = createContext<MapEditApi>(READ_ONLY);

export const useMapEdit = (): MapEditApi => useContext(MapEditContext);
