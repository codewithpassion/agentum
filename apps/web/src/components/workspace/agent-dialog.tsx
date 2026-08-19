import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { TextAreaField, TextField } from "#/components/ui/field";
import {
  type Agent,
  type AgentInput,
  createAgent,
  rotateAgentMcpToken,
  updateAgent,
} from "#/lib/api";
import { McpUrlField } from "./mcp-url";

const EMPTY: AgentInput = { instructions: "", name: "", soul: "" };

export function AgentDialog({
  agent,
  mcpUrl,
  onClose,
  onSaved,
  onTokenIssued,
  open,
}: {
  /** Present when editing; absent when creating. */
  agent: Agent | null;
  /** Known only while this session still holds a freshly issued token. */
  mcpUrl: string | null;
  onClose: () => void;
  onSaved: (agent: Agent) => Promise<void>;
  onTokenIssued: (agentId: string, mcpUrl: string) => void;
  open: boolean;
}) {
  const [draft, setDraft] = useState<AgentInput>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState(false);

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

  const rotate = useCallback(async () => {
    if (!agent) {
      return;
    }
    setRotating(true);
    try {
      const issued = await rotateAgentMcpToken(agent.id);
      onTokenIssued(agent.id, issued.mcpUrl);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to rotate the token."
      );
    } finally {
      setRotating(false);
    }
  }, [agent, onTokenIssued]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      try {
        let saved: Agent;
        if (agent) {
          saved = await updateAgent(agent.id, draft);
        } else {
          const issued = await createAgent(draft);
          saved = issued.agent;
          onTokenIssued(saved.id, issued.mcpUrl);
        }
        await onSaved(saved);
        onClose();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to save.");
      } finally {
        setBusy(false);
      }
    },
    [agent, draft, onClose, onSaved, onTokenIssued]
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

        {agent ? (
          <McpUrlField onRotate={rotate} rotating={rotating} url={mcpUrl} />
        ) : null}

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
