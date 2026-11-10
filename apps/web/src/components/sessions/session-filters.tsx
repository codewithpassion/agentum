import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { Input } from "#/components/ui/input.tsx";
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
  onQueryChange: (next: string | undefined) => void;
  onWorkingChange: (next: boolean) => void;
  origin: OriginValue | undefined;
  query: string | undefined;
  working: boolean;
}

const isOriginValue = (value: string): value is OriginValue =>
  ORIGIN_VALUES.some((origin) => origin === value);

export function SessionFilters({
  agentId,
  agents,
  onAgentChange,
  onOriginChange,
  onQueryChange,
  onWorkingChange,
  origin,
  query,
  working,
}: SessionFiltersProps) {
  const [text, setText] = useState(query ?? "");
  const handleTextChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setText(event.target.value),
    []
  );
  const handleSearch = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = text.trim();
      onQueryChange(trimmed === "" ? undefined : trimmed);
    },
    [onQueryChange, text]
  );
  const handleWorkingChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onWorkingChange(event.target.checked),
    [onWorkingChange]
  );
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
    <div className="flex flex-wrap items-end gap-4">
      <form
        className="flex min-w-0 flex-[1_1_220px] flex-col gap-2"
        onSubmit={handleSearch}
      >
        <Label htmlFor="sessions-search">Search</Label>
        <Input
          id="sessions-search"
          maxLength={200}
          onChange={handleTextChange}
          placeholder="Search titles and messages"
          type="search"
          value={text}
        />
      </form>
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
      <div className="flex min-h-9 items-center gap-2">
        <input
          checked={working}
          id="sessions-working"
          onChange={handleWorkingChange}
          type="checkbox"
        />
        <Label htmlFor="sessions-working">Running now</Label>
      </div>
    </div>
  );
}
