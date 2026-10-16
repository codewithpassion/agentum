import { type ChangeEvent, useCallback } from "react";
import { Label } from "#/components/ui/label.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select.tsx";
import {
  ORIGIN_LABELS,
  ORIGIN_VALUES,
  type OriginValue,
} from "./sessions-logic.ts";

interface SessionFiltersProps {
  agentId: string | undefined;
  agents: readonly { id: string; name: string }[];
  onAgentChange: (next: string | undefined) => void;
  onOriginChange: (next: OriginValue | undefined) => void;
  origin: OriginValue | undefined;
}

const isOriginValue = (value: string): value is OriginValue =>
  ORIGIN_VALUES.some((origin) => origin === value);

export function SessionFilters({
  agentId,
  agents,
  onAgentChange,
  onOriginChange,
  origin,
}: SessionFiltersProps) {
  const handleAgentChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const { value } = event.target;
      onAgentChange(value === "" ? undefined : value);
    },
    [onAgentChange]
  );

  const handleOriginChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const { value } = event.target;
      if (value === "") {
        onOriginChange(undefined);
      } else if (isOriginValue(value)) {
        onOriginChange(value);
      }
    },
    [onOriginChange]
  );

  return (
    <div className="flex flex-wrap gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="sessions-agent">Agent</Label>
        <NativeSelect
          id="sessions-agent"
          onChange={handleAgentChange}
          value={agentId ?? ""}
        >
          <NativeSelectOption value="">All agents</NativeSelectOption>
          {agents.map((agent) => (
            <NativeSelectOption key={agent.id} value={agent.id}>
              {agent.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="sessions-origin">Origin</Label>
        <NativeSelect
          id="sessions-origin"
          onChange={handleOriginChange}
          value={origin ?? ""}
        >
          <NativeSelectOption value="">All origins</NativeSelectOption>
          {ORIGIN_VALUES.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {ORIGIN_LABELS[value]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
    </div>
  );
}
