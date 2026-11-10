import { type ChangeEvent, useCallback } from "react";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
  addChip,
  removeChip,
  type SampleChip,
  updateChip,
} from "./dry-run-logic.ts";
import { DryRunResult } from "./dry-run-result.tsx";

function SampleChipEditor({
  chip,
  index,
  onChange,
  onRemove,
}: {
  chip: SampleChip;
  index: number;
  onChange: (index: number, patch: Partial<SampleChip>) => void;
  onRemove: (index: number) => void;
}) {
  const changeKey = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange(index, { key: event.target.value }),
    [index, onChange]
  );
  const changeValue = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange(index, { value: event.target.value }),
    [index, onChange]
  );
  const remove = useCallback(() => onRemove(index), [index, onRemove]);
  return (
    <span className="inline-flex items-center gap-1 rounded-md border bg-card p-0.5">
      <Input
        aria-label={`Sample key ${index + 1}`}
        className="h-7 w-24 font-mono text-xs"
        onChange={changeKey}
        placeholder="key"
        value={chip.key}
      />
      <Input
        aria-label={`Sample value ${index + 1}`}
        className="h-7 w-36 text-xs"
        onChange={changeValue}
        placeholder="value"
        value={chip.value}
      />
      <button
        aria-label={`Remove sample ${index + 1}`}
        className="px-1 text-muted-foreground hover:text-foreground"
        onClick={remove}
        type="button"
      >
        ×
      </button>
    </span>
  );
}

const runLabel = (running: boolean, hasRun: boolean): string => {
  if (running) {
    return "Starting the dry run...";
  }
  return hasRun ? "Run the dry run again" : "Run the dry run";
};

/** What the panel is busy with. */
export type DryRunStep = "create" | "discard" | "run";

export interface DryRunPanelProps {
  /** Why Create is disabled, or null. */
  createBlocker: string | null;
  /** A failed run, create or discard. */
  error: string | null;
  onCreate: () => void;
  onDiscard: () => void;
  onRun: () => void;
  onSample: (sample: SampleChip[]) => void;
  /** The step in flight, or null. */
  pending: DryRunStep | null;
  /** Why the dry run cannot start, or null. */
  runBlocker: string | null;
  /** The run to show, or null before the first one. */
  runId: string | null;
  /** Where the dry run runs, in a sentence. */
  runtimeNote: string;
  sample: SampleChip[];
}

/** The dry-run card under the draft: sample chips, the run's receipt, then Create and Discard. */
export function DryRunPanel({
  createBlocker,
  error,
  onCreate,
  onDiscard,
  onRun,
  onSample,
  pending,
  runBlocker,
  runId,
  runtimeNote,
  sample,
}: DryRunPanelProps) {
  const changeChip = useCallback(
    (index: number, patch: Partial<SampleChip>) =>
      onSample(updateChip(sample, index, patch)),
    [onSample, sample]
  );
  const removeSample = useCallback(
    (index: number) => onSample(removeChip(sample, index)),
    [onSample, sample]
  );
  const addSample = useCallback(
    () => onSample(addChip(sample)),
    [onSample, sample]
  );
  const busy = pending !== null;
  const blockedBy = createBlocker ?? runBlocker;

  return (
    <section
      aria-label="Dry run"
      className="flex flex-col gap-3"
      data-testid="dry-run-panel"
    >
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-base">Dry run on a sample</h2>
          <span className="text-muted-foreground text-xs">
            Nothing is saved or sent.
          </span>
        </div>
        <p className="text-muted-foreground text-xs">{runtimeNote}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {sample.map((chip, index) => (
            <SampleChipEditor
              chip={chip}
              index={index}
              // The chips have no id and the list is edited in place by index.
              // biome-ignore lint/suspicious/noArrayIndexKey: Edited in place by index.
              key={index}
              onChange={changeChip}
              onRemove={removeSample}
            />
          ))}
          <button
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-dashed px-2.5 py-0.5 text-muted-foreground text-xs hover:text-foreground"
            onClick={addSample}
            type="button"
          >
            + Add input
          </button>
        </div>
        {runId === null ? null : <DryRunResult runId={runId} />}
      </div>

      {error === null ? null : (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={busy || runBlocker !== null}
          onClick={onRun}
          type="button"
          variant="outline"
        >
          {runLabel(pending === "run", runId !== null)}
        </Button>
        <Button
          disabled={busy || blockedBy !== null}
          onClick={onCreate}
          type="button"
        >
          {pending === "create" ? "Creating..." : "Create agent"}
        </Button>
        <Button
          disabled={busy}
          onClick={onDiscard}
          type="button"
          variant="ghost"
        >
          Discard
        </Button>
      </div>
      {blockedBy === null ? null : (
        <p className="text-muted-foreground text-xs" data-testid="create-why">
          {blockedBy}
        </p>
      )}
    </section>
  );
}
