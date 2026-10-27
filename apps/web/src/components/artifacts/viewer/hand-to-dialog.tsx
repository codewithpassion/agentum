import { XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "#/components/ui/radio-group";
import { getTrpc } from "#/integrations/trpc/client";
import {
  type HandToAgent,
  handToAgentId,
  handToValue,
  NOBODY_VALUE,
} from "./hand-to-model.ts";

interface HandToFormProps {
  agents: readonly HandToAgent[];
  error: string | null;
  loading: boolean;
  onSave: () => void;
  onSelect: (value: string) => void;
  saving: boolean;
  selected: string;
}

interface RowProps {
  id: string;
  label: string;
  value: string;
}

function Row({ id, label, value }: RowProps) {
  return (
    <div className="flex min-h-10 items-center gap-3 md:min-h-8">
      <RadioGroupItem id={id} value={value} />
      <label
        className="flex min-h-10 flex-1 items-center text-sm md:min-h-8"
        htmlFor={id}
      >
        {label}
      </label>
    </div>
  );
}

/** The radio list and Save button; its state comes in as props. */
export function HandToForm({
  agents,
  error,
  loading,
  onSave,
  onSelect,
  saving,
  selected,
}: HandToFormProps) {
  return (
    <div className="flex flex-col gap-3">
      <RadioGroup onValueChange={onSelect} value={selected}>
        <Row
          id="hand-to-nobody"
          label="Nobody (keep it with me)"
          value={NOBODY_VALUE}
        />
        {agents.map((agent) => (
          <Row
            id={`hand-to-${agent.id}`}
            key={agent.id}
            label={agent.name}
            value={agent.id}
          />
        ))}
      </RadioGroup>
      {loading ? (
        <p className="text-muted-foreground text-sm">Loading agents...</p>
      ) : null}
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        className="h-10 md:h-8"
        disabled={saving || loading}
        onClick={onSave}
      >
        {saving ? "Saving..." : "Save"}
      </Button>
    </div>
  );
}

export interface HandToDialogProps {
  artifactId: string;
  currentAgentId: string | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  open: boolean;
}

export function HandToDialog({
  artifactId,
  currentAgentId,
  onOpenChange,
  onSaved,
  open,
}: HandToDialogProps) {
  const [agents, setAgents] = useState<readonly HandToAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(handToValue(currentAgentId));

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setSelected(handToValue(currentAgentId));
    setError(null);
    setLoading(true);
    getTrpc()
      .agents.list.query({})
      .then((rows) => {
        if (!cancelled) {
          setAgents(rows.map((row) => ({ id: row.id, name: row.name })));
          setLoading(false);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(
            caught instanceof Error ? caught.message : "Could not load agents"
          );
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, currentAgentId]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await getTrpc().artifacts.handTo.mutate({
        agentId: handToAgentId(selected),
        artifactId,
      });
      toast.success(
        selected === NOBODY_VALUE ? "Kept with you" : "Handed to the agent"
      );
      onOpenChange(false);
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }, [artifactId, onOpenChange, onSaved, selected]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent showCloseButton={false}>
        {/* 40 px on phones, since the built-in close button is 28 px (R1.26). */}
        <DialogClose asChild>
          <Button
            className="absolute top-2 right-2 size-10"
            size="icon"
            variant="ghost"
          >
            <XIcon aria-hidden />
            <span className="sr-only">Close</span>
          </Button>
        </DialogClose>
        <DialogHeader>
          <DialogTitle>Hand to agent</DialogTitle>
        </DialogHeader>
        <HandToForm
          agents={agents}
          error={error}
          loading={loading}
          onSave={save}
          onSelect={setSelected}
          saving={saving}
          selected={selected}
        />
      </DialogContent>
    </Dialog>
  );
}
