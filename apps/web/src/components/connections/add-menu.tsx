import { useCallback } from "react";
import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";

export type AddChoice = "invite" | "join" | "outside";

const CHOICES: { choice: AddChoice; label: string }[] = [
  { choice: "invite", label: "Invite" },
  { choice: "join", label: "Join with a link" },
  { choice: "outside", label: "Outside agent" },
];

function AddMenuItem({
  choice,
  label,
  onChoose,
}: {
  choice: AddChoice;
  label: string;
  onChoose: (choice: AddChoice) => void;
}) {
  const choose = useCallback(() => onChoose(choice), [choice, onChoose]);

  return <DropdownMenuItem onSelect={choose}>{label}</DropdownMenuItem>;
}

export function AddMenu({
  onChoose,
}: {
  onChoose: (choice: AddChoice) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>Add connection</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {CHOICES.map((entry) => (
          <AddMenuItem
            choice={entry.choice}
            key={entry.choice}
            label={entry.label}
            onChoose={onChoose}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
