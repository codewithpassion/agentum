import type { CredentialMode } from "@repo/db/shared";
import { type ChangeEvent, useCallback, useId, useMemo, useState } from "react";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import {
  extraToolNames,
  matchesToolFilter,
  type ToolEntry,
} from "./allowed-tools.ts";

const EXTRA_DESCRIPTION = "Not in the cached tool list. Kept as saved.";

function ToolOption({
  checked,
  description,
  name,
  onToggle,
}: {
  checked: boolean;
  description: string | null;
  name: string;
  onToggle: (name: string, checked: boolean) => void;
}) {
  const id = useId();
  const handleCheckedChange = useCallback(
    (value: boolean | "indeterminate") => onToggle(name, value === true),
    [name, onToggle]
  );

  return (
    <div className="flex items-start gap-3 rounded-md px-2 py-1.5 hover:bg-muted">
      <Checkbox
        checked={checked}
        className="mt-0.5"
        id={id}
        onCheckedChange={handleCheckedChange}
      />
      <Label className="flex min-w-0 cursor-pointer flex-col" htmlFor={id}>
        <span className="font-mono text-xs">{name}</span>
        {description === null ? null : (
          <span className="text-muted-foreground text-xs">{description}</span>
        )}
      </Label>
    </div>
  );
}

export function AllowedToolsDialog({
  agentId,
  allowedTools,
  connector,
  credentialMode,
  onClose,
  onSaved,
}: {
  agentId: string;
  allowedTools: string[] | null;
  connector: { id: string; name: string; tools: ToolEntry[] };
  credentialMode: CredentialMode;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(allowedTools ?? [])
  );
  const [filter, setFilter] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { tools } = connector;
  const extras = useMemo(
    () => extraToolNames(allowedTools, tools),
    [allowedTools, tools]
  );
  const visibleTools = useMemo(
    () => tools.filter((tool) => matchesToolFilter(tool, filter)),
    [tools, filter]
  );
  const visibleExtras = useMemo(
    () =>
      extras.filter((name) =>
        matchesToolFilter({ description: null, name }, filter)
      ),
    [extras, filter]
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );

  const handleFilterChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setFilter(event.target.value);
    },
    []
  );

  const toggleTool = useCallback((name: string, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) {
        next.add(name);
      } else {
        next.delete(name);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const tool of tools) {
        next.add(tool.name);
      }
      return next;
    });
  }, [tools]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const save = useCallback(
    async (names: string[]) => {
      setPending(true);
      setError(null);
      try {
        await getTrpc().connectors.assign.mutate({
          agentId,
          allowedTools: names,
          connectorId: connector.id,
          credentialMode,
        });
        onSaved();
      } catch (caught) {
        setError(errorMessage(caught));
        setPending(false);
      }
    },
    [agentId, connector.id, credentialMode, onSaved]
  );

  const saveSelection = useCallback(
    () => save([...selected]),
    [save, selected]
  );

  const clearList = useCallback(() => save([]), [save]);

  const hasTools = tools.length > 0;
  const noMatches =
    hasTools && visibleTools.length === 0 && visibleExtras.length === 0;

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tools for {connector.name}</DialogTitle>
          <DialogDescription>
            Choose the tools this agent can use through {connector.name}.
          </DialogDescription>
        </DialogHeader>
        {hasTools ? (
          <div className="flex flex-col gap-3">
            <Input
              aria-label="Filter tools"
              autoComplete="off"
              onChange={handleFilterChange}
              placeholder="Filter tools"
              value={filter}
            />
            <div className="flex items-center gap-2">
              <Button
                disabled={pending}
                onClick={selectAll}
                size="sm"
                variant="outline"
              >
                Select all
              </Button>
              <Button
                disabled={pending}
                onClick={clearSelection}
                size="sm"
                variant="outline"
              >
                Clear
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              When no tool is ticked, the agent can use every tool.
            </p>
            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {visibleTools.map((tool) => (
                <ToolOption
                  checked={selected.has(tool.name)}
                  description={tool.description}
                  key={tool.name}
                  name={tool.name}
                  onToggle={toggleTool}
                />
              ))}
              {visibleExtras.map((name) => (
                <ToolOption
                  checked={selected.has(name)}
                  description={EXTRA_DESCRIPTION}
                  key={name}
                  name={name}
                  onToggle={toggleTool}
                />
              ))}
              {noMatches ? (
                <p className="text-muted-foreground text-sm">No tools match.</p>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            This connector has no cached tool list, so tools cannot be picked
            here. Clearing the list allows every tool.
          </p>
        )}
        {error !== null && <p className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          {hasTools ? (
            <Button disabled={pending} onClick={saveSelection}>
              Save
            </Button>
          ) : (
            <Button disabled={pending} onClick={clearList}>
              Clear list
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
