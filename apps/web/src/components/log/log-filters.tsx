import { EVENT_TYPES, type EventType } from "@repo/db/shared";
import { type ChangeEvent, useCallback } from "react";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select.tsx";
import { isEventType } from "./log-logic.ts";

interface LogFilterPatch {
  agent?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  type?: EventType | undefined;
}

interface LogFiltersProps {
  agentId: string | undefined;
  agents: readonly { id: string; name: string }[];
  from: string | undefined;
  onChange: (patch: LogFilterPatch) => void;
  to: string | undefined;
  type: EventType | undefined;
}

const emptyToUndefined = (value: string): string | undefined =>
  value === "" ? undefined : value;

export function LogFilters({
  agentId,
  agents,
  from,
  onChange,
  to,
  type,
}: LogFiltersProps) {
  const handleAgentChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      onChange({ agent: emptyToUndefined(event.target.value) });
    },
    [onChange]
  );

  const handleTypeChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const { value } = event.target;
      if (value === "") {
        onChange({ type: undefined });
      } else if (isEventType(value)) {
        onChange({ type: value });
      }
    },
    [onChange]
  );

  const handleFromChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange({ from: emptyToUndefined(event.target.value) });
    },
    [onChange]
  );

  const handleToChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange({ to: emptyToUndefined(event.target.value) });
    },
    [onChange]
  );

  return (
    <div className="flex flex-wrap gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="log-agent">Agent</Label>
        <NativeSelect
          id="log-agent"
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
        <Label htmlFor="log-type">Type</Label>
        <NativeSelect
          id="log-type"
          onChange={handleTypeChange}
          value={type ?? ""}
        >
          <NativeSelectOption value="">All types</NativeSelectOption>
          {EVENT_TYPES.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {value}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="log-from">From</Label>
        <Input
          id="log-from"
          onChange={handleFromChange}
          type="date"
          value={from ?? ""}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="log-to">To</Label>
        <Input
          id="log-to"
          onChange={handleToChange}
          type="date"
          value={to ?? ""}
        />
      </div>
    </div>
  );
}
