import { Bot } from "lucide-react";
import { useCallback } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "#/components/ui/command";
import {
  agentFindEntries,
  type FindEntry,
  findEntries,
} from "./find-registry.ts";
import { useGo } from "./rail-link.tsx";

const groupNames = [...new Set(findEntries.map((entry) => entry.group))];

function FindItem({
  entry,
  onPick,
}: {
  entry: Omit<FindEntry, "group">;
  onPick: (to: string) => void;
}) {
  const Icon = entry.icon;
  const handleSelect = useCallback(() => onPick(entry.to), [entry.to, onPick]);
  return (
    <CommandItem
      keywords={entry.hint === undefined ? [] : [entry.hint]}
      onSelect={handleSelect}
      value={`${entry.label} ${entry.to}`}
    >
      <Icon />
      <span className="flex-1">{entry.label}</span>
      {entry.hint === undefined ? null : (
        <span className="text-muted-foreground text-xs">{entry.hint}</span>
      )}
    </CommandItem>
  );
}

/** Every page and every agent, searchable. Opens with Ctrl+K or Cmd+K. */
export function FindDialog({
  agents,
  onOpenChange,
  open,
}: {
  agents: readonly { id: string; name: string }[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const go = useGo();
  const handlePick = useCallback(
    (to: string) => {
      onOpenChange(false);
      go(to);
    },
    [go, onOpenChange]
  );
  return (
    <CommandDialog
      description="Find an agent, a page or a setting"
      onOpenChange={onOpenChange}
      open={open}
      title="Find"
    >
      <Command>
        <CommandInput placeholder="Find an agent, a page or a setting" />
        <CommandList>
          <CommandEmpty>Nothing matches.</CommandEmpty>
          {groupNames.map((group) => (
            <CommandGroup heading={group} key={group}>
              {findEntries
                .filter((entry) => entry.group === group)
                .map((entry) => (
                  <FindItem entry={entry} key={entry.to} onPick={handlePick} />
                ))}
              {group === "Agents"
                ? agentFindEntries(agents).map((agent) => (
                    <FindItem
                      entry={{ ...agent, icon: Bot }}
                      key={agent.id}
                      onPick={handlePick}
                    />
                  ))
                : null}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
