import type { BuilderCatalog } from "@repo/services/agent-builder/draft";
import { type ChangeEvent, useCallback, useMemo, useState } from "react";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { blankBlocker, blankDraft, runsOnOptions } from "./builder-logic.ts";
import { ToggleChip } from "./toggle-chip.tsx";

export interface StartBlankProps {
  busy: boolean;
  catalog: BuilderCatalog;
  error: string | null;
  /** Saves the draft and activates it. */
  onCreate: (draft: ReturnType<typeof blankDraft>) => void;
}

/** Name, what it does and where it runs, then Create. No model key is needed. */
export function StartBlank({
  busy,
  catalog,
  error,
  onCreate,
}: StartBlankProps) {
  const [name, setName] = useState("");
  const [does, setDoes] = useState("");
  const [runsKey, setRunsKey] = useState<string | undefined>();
  const options = runsOnOptions(catalog, null);
  const runsOn =
    options.find((option) => option.key === runsKey)?.value ?? null;
  const input = useMemo(() => ({ does, name, runsOn }), [does, name, runsOn]);
  const blocker = blankBlocker(input);

  const changeName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );
  const changeDoes = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => setDoes(event.target.value),
    []
  );
  const create = useCallback(() => {
    if (blocker === null) {
      onCreate(blankDraft(input));
    }
  }, [blocker, input, onCreate]);

  return (
    <section
      aria-label="Start blank"
      className="flex max-w-xl flex-col gap-3.5 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="blank-name">Name</Label>
        <Input
          id="blank-name"
          onChange={changeName}
          placeholder="Invoice chaser"
          value={name}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="blank-does">What it does</Label>
        <Textarea
          id="blank-does"
          onChange={changeDoes}
          placeholder="Finds overdue invoices and drafts a reminder for each."
          rows={4}
          value={does}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="font-medium text-sm">Runs on</span>
        <div className="flex flex-wrap gap-1.5">
          {options.length === 0 ? (
            <span className="text-muted-foreground text-xs">
              No runtime is available. Add a provider key or a machine in
              Settings.
            </span>
          ) : null}
          {options.map((option) => (
            <ToggleChip
              id={option.key}
              key={option.key}
              label={
                option.note === null
                  ? option.label
                  : `${option.label} (${option.note})`
              }
              onToggle={setRunsKey}
              selected={option.key === runsKey}
            />
          ))}
        </div>
      </div>
      {error === null ? null : (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={busy || blocker !== null}
          onClick={create}
          type="button"
        >
          {busy ? "Creating..." : "Create agent"}
        </Button>
        {blocker === null ? null : (
          <span className="text-muted-foreground text-xs">{blocker}</span>
        )}
      </div>
    </section>
  );
}
