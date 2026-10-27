import { type ChangeEvent, useCallback, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select.tsx";
import {
  connectChoices,
  deletableWiresFrom,
  type MapTool,
  toolOfPort,
} from "./editor-logic.ts";
import type { MapPortData } from "./map-types.ts";

const HEADING =
  "mt-3 font-medium text-muted-foreground text-xs uppercase tracking-wide";

/** What the touch controls call. They are the same actions as the canvas gestures. */
export interface TouchActions {
  onConnectWire: (sourceKey: string, targetKey: string) => void;
  onDeleteWire: (edgeId: string) => void;
  onUnplug: (agentId: string, tool: MapTool) => void;
}

type TouchGraph = Parameters<typeof connectChoices>[0];

/**
 * "Connect to" and "Delete wire" for a trigger. They stand in for drawing a
 * wire from a tiny handle and for the small × on the wire.
 */
export function TriggerWireControls({
  actions,
  graph,
  triggerKey,
}: {
  actions: TouchActions;
  graph: TouchGraph;
  triggerKey: string;
}) {
  const [target, setTarget] = useState("");
  const choices = connectChoices(graph, triggerKey);
  const wires = deletableWiresFrom(graph, triggerKey);
  const pick = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => setTarget(event.target.value),
    []
  );
  const connect = useCallback(() => {
    if (target !== "") {
      actions.onConnectWire(triggerKey, target);
      setTarget("");
    }
  }, [actions, target, triggerKey]);
  if (choices.length === 0 && wires.length === 0) {
    return null;
  }
  return (
    <div data-testid="inspector-wire-controls">
      <p className={HEADING}>Wire</p>
      {choices.length === 0 ? null : (
        <div className="mt-1 flex items-center gap-2">
          <NativeSelect
            aria-label="Connect to"
            className="min-w-0 flex-1 [&_select]:h-10"
            onChange={pick}
            value={target}
          >
            <NativeSelectOption value="">Connect to…</NativeSelectOption>
            {choices.map((choice) => (
              <NativeSelectOption key={choice.key} value={choice.key}>
                {choice.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            className="min-h-10"
            disabled={target === ""}
            onClick={connect}
            type="button"
            variant="outline"
          >
            Connect
          </Button>
        </div>
      )}
      {wires.map((wire) => (
        <DeleteWireButton actions={actions} key={wire.edgeId} wire={wire} />
      ))}
    </div>
  );
}

function DeleteWireButton({
  actions,
  wire,
}: {
  actions: TouchActions;
  wire: { edgeId: string; label: string };
}) {
  const remove = useCallback(
    () => actions.onDeleteWire(wire.edgeId),
    [actions, wire.edgeId]
  );
  return (
    <Button
      className="mt-2 min-h-10 w-full justify-start"
      onClick={remove}
      type="button"
      variant="outline"
    >
      Delete wire to {wire.label}
    </Button>
  );
}

function RemovePortButton({
  actions,
  agentId,
  port,
}: {
  actions: TouchActions;
  agentId: string;
  port: MapPortData;
}) {
  const remove = useCallback(
    () => actions.onUnplug(agentId, toolOfPort(port)),
    [actions, agentId, port]
  );
  return (
    <li className="flex items-center justify-between gap-2 border-border border-t py-1 text-sm">
      <span className="min-w-0 truncate">{port.label}</span>
      <Button
        aria-label={`Remove ${port.label}`}
        className="min-h-10"
        onClick={remove}
        type="button"
        variant="outline"
      >
        Remove
      </Button>
    </li>
  );
}

/** A "Remove" button for each tool, skill and computer plugged into the agent. */
export function PluggedRemoveList({
  actions,
  agentId,
  ports,
}: {
  actions: TouchActions;
  agentId: string;
  ports: MapPortData[];
}) {
  if (ports.length === 0) {
    return null;
  }
  return (
    <div data-testid="inspector-plugged-list">
      <p className={HEADING}>Unplug</p>
      <ul>
        {ports.map((port) => (
          <RemovePortButton
            actions={actions}
            agentId={agentId}
            key={`${port.kind}-${port.id}`}
            port={port}
          />
        ))}
      </ul>
    </div>
  );
}
