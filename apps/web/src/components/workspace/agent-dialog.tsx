import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { TextAreaField, TextField } from "#/components/ui/field";
import {
  type Agent,
  type AgentInput,
  createAgent,
  updateAgent,
} from "#/lib/api";

const EMPTY: AgentInput = { instructions: "", name: "", soul: "" };

export function AgentDialog({
  agent,
  onClose,
  onSaved,
  open,
}: {
  /** Present when editing; absent when creating. */
  agent: Agent | null;
  onClose: () => void;
  onSaved: (agent: Agent) => Promise<void>;
  open: boolean;
}) {
  const [draft, setDraft] = useState<AgentInput>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDraft(
      agent
        ? {
            instructions: agent.instructions,
            name: agent.name,
            soul: agent.soul,
          }
        : EMPTY
    );
    setError(null);
  }, [agent, open]);

  const onNameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setDraft((previous) => ({ ...previous, name: event.target.value })),
    []
  );
  const onSoulChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) =>
      setDraft((previous) => ({ ...previous, soul: event.target.value })),
    []
  );
  const onInstructionsChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) =>
      setDraft((previous) => ({
        ...previous,
        instructions: event.target.value,
      })),
    []
  );

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      try {
        const saved = agent
          ? await updateAgent(agent.id, draft)
          : await createAgent(draft);
        await onSaved(saved);
        onClose();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to save.");
      } finally {
        setBusy(false);
      }
    },
    [agent, draft, onClose, onSaved]
  );

  return (
    <Dialog
      onClose={onClose}
      open={open}
      title={agent ? `Edit ${agent.name}` : "New agent"}
    >
      <form className="space-y-4" onSubmit={submit}>
        <TextField
          label="Name"
          maxLength={80}
          onChange={onNameChange}
          placeholder="Chief of Staff"
          required
          value={draft.name}
        />
        <TextAreaField
          hint="Personality and voice - who this agent is."
          label="Soul"
          onChange={onSoulChange}
          placeholder="Calm, decisive, allergic to busywork."
          rows={3}
          value={draft.soul}
        />
        <TextAreaField
          hint="What this agent does and how it should work."
          label="Instructions"
          onChange={onInstructionsChange}
          placeholder="Triage requests, delegate to specialists, report back in-thread."
          rows={5}
          value={draft.instructions}
        />

        {error ? (
          <p className="m-0 text-[var(--ws-danger)] text-xs">{error}</p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={busy} type="submit" variant="primary">
            {agent ? "Save changes" : "Create agent"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
