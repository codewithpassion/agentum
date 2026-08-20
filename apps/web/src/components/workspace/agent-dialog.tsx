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
import { AgentConnectorsPicker } from "./agent-connectors-picker";
import { McpUrlField } from "./mcp-url";

const EMPTY: AgentInput = { instructions: "", name: "", soul: "" };

/**
 * The agent's settings, in sections (plan 5e): the dialog was already crowded
 * with the profile alone, and Phase 5 adds Skills next to Connectors. Adding a
 * section is appending to this array and a branch in the panel below.
 *
 * Only an agent that exists has sections - a new one has no id to assign
 * anything to yet, so creating stays the single profile form it always was.
 */
const SECTIONS = ["Profile", "Connectors"] as const;

type Section = (typeof SECTIONS)[number];

function SectionTab({
  active,
  onSelect,
  section,
}: {
  active: boolean;
  onSelect: (section: Section) => void;
  section: Section;
}) {
  const select = useCallback(() => onSelect(section), [onSelect, section]);

  return (
    <button
      aria-selected={active}
      className={`ws-focus w-full rounded-md px-2 py-1 text-xs ${active ? "bg-[var(--ws-panel)] text-[var(--ws-text)]" : "text-[var(--ws-muted)] hover:text-[var(--ws-text)]"}`}
      onClick={select}
      role="tab"
      type="button"
    >
      {section}
    </button>
  );
}

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
  const [section, setSection] = useState<Section>("Profile");

  useEffect(() => {
    if (!open) {
      return;
    }
    setSection("Profile");
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
      title={agent ? `${agent.name} settings` : "New agent"}
    >
      {agent ? (
        <div
          aria-label="Agent settings"
          className="mb-4 flex gap-1 rounded-lg bg-[var(--ws-surface)] p-1"
          role="tablist"
        >
          {SECTIONS.map((name) => (
            <div className="flex-1" key={name}>
              <SectionTab
                active={section === name}
                onSelect={setSection}
                section={name}
              />
            </div>
          ))}
        </div>
      ) : null}

      {agent && section === "Connectors" ? (
        <div role="tabpanel">
          <AgentConnectorsPicker agentId={agent.id} />
        </div>
      ) : null}

      <form
        className={section === "Profile" ? "space-y-4" : "hidden"}
        onSubmit={submit}
      >
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
