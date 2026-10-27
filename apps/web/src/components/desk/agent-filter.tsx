import { useCallback } from "react";
import { Button } from "#/components/ui/button.tsx";

function FilterChip({
  id,
  label,
  onSelect,
  selected,
}: {
  id: string | null;
  label: string;
  onSelect: (id: string | null) => void;
  selected: boolean;
}) {
  const handleClick = useCallback(() => onSelect(id), [id, onSelect]);
  return (
    <Button
      aria-pressed={selected}
      className="rounded-full"
      onClick={handleClick}
      size="sm"
      type="button"
      variant={selected ? "default" : "outline"}
    >
      {label}
    </Button>
  );
}

/** "All agents" plus one chip per agent. `selected` is null for all. */
export function AgentFilter({
  agents,
  onSelect,
  selected,
}: {
  agents: readonly { id: string; name: string }[];
  onSelect: (id: string | null) => void;
  selected: string | null;
}) {
  return (
    <fieldset
      aria-label="Filter by agent"
      className="m-0 flex min-w-0 flex-wrap gap-1.5 pointer-coarse:gap-2 border-0 p-0"
    >
      <FilterChip
        id={null}
        label="All agents"
        onSelect={onSelect}
        selected={selected === null}
      />
      {agents.map((agent) => (
        <FilterChip
          id={agent.id}
          key={agent.id}
          label={agent.name}
          onSelect={onSelect}
          selected={selected === agent.id}
        />
      ))}
    </fieldset>
  );
}
