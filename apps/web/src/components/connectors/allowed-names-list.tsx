import { useCallback } from "react";
import { Button } from "#/components/ui/button";

function AllowedNameRow({
  disabled,
  name,
  onRemove,
}: {
  disabled: boolean;
  name: string;
  onRemove: (name: string) => void;
}) {
  const handleRemove = useCallback(() => onRemove(name), [name, onRemove]);

  return (
    <li className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted">
      <span className="min-w-0 break-all font-mono text-xs">{name}</span>
      <Button
        aria-label={`Remove ${name}`}
        disabled={disabled}
        onClick={handleRemove}
        size="sm"
        variant="outline"
      >
        Remove
      </Button>
    </li>
  );
}

export function AllowedNamesList({
  disabled,
  names,
  onRemove,
}: {
  disabled: boolean;
  names: string[];
  onRemove: (name: string) => void;
}) {
  return (
    <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
      {names.map((name) => (
        <AllowedNameRow
          disabled={disabled}
          key={name}
          name={name}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );
}
