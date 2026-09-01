import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { SelectField, TextAreaField, TextField } from "#/components/ui/field";
import type { Agent, AgentInput, ComputerHost } from "#/lib/api";
import { computerSummary, hostChoicesFor } from "#/lib/computer-hosts";
import { WORKSPACE_DEFAULT_MODEL_LABEL } from "#/lib/model-format";
import { useComputerHosts } from "#/lib/use-computer-hosts";
import { useApi } from "#/lib/workspace-context";
import {
  type AgentComputer,
  type AgentRuntime,
  isAgentComputer,
  isAgentRuntime,
} from "#/modules/agents/schema";
import { AgentConnectorsPicker } from "./agent-connectors-picker";
import { AgentSkillsPicker } from "./agent-skills-picker";
import { AgentSlackPanel } from "./agent-slack-panel";
import { CloudflareModelField } from "./cloudflare-model-field";
import { McpUrlField } from "./mcp-url";
import { ModelSelect } from "./model-select";

const EMPTY: AgentInput = {
  computer: "cloudflare",
  computerHostId: null,
  instructions: "",
  model: null,
  name: "",
  runtime: "managed",
  soul: "",
};

/**
 * Where the agent's loop runs. Chosen once, when the agent is created: the
 * two runtimes keep incompatible session state, so the API refuses a change.
 */
const RUNTIME_OPTIONS: { hint: string; label: string; value: AgentRuntime }[] =
  [
    {
      hint: "Anthropic's Managed Agents: cloud sessions with a sandbox, subagents and connectors. Needs an Anthropic API key.",
      label: "Claude Managed Agents",
      value: "managed",
    },
    {
      hint: "The loop runs in a Durable Object on Cloudflare and calls a model on Workers AI, or any provider through AI Gateway. No Anthropic key needed; no subagents, sandbox or connectors.",
      label: "Cloudflare (Workers AI / AI Gateway)",
      value: "cloudflare",
    },
  ];

const runtimeHint = (runtime: AgentRuntime): string =>
  RUNTIME_OPTIONS.find((option) => option.value === runtime)?.hint ?? "";

/**
 * Where the agent's *computer* runs - the files and the shell behind the
 * `computer_*` tools, which is a separate choice from where its loop runs, and
 * fixed at creation for the same reason: the files live in the backend, so
 * moving them would be a migration rather than a toggle.
 */
const COMPUTER_OPTIONS: {
  hint: string;
  label: string;
  value: AgentComputer;
}[] = [
  {
    hint: "The Durable Object the agent already lives in. Its files work everywhere, but the shell only runs in development - the Worker Loader behind it is not available in production.",
    label: "Cloudflare (default; files only in production)",
    value: "cloudflare",
  },
  {
    hint: "A Fly Machine of its own, with its own volume, in one of your Fly apps: a real Linux shell in production. Fly starts the machine on the first command and stops it when the agent goes idle.",
    label: "Fly.io host…",
    value: "fly",
  },
  {
    hint: "A container you run on your own hardware: a real Linux shell in production. The container runs whatever the agent decides to run, with the network access the container has - which machine and which network that is, is yours to choose.",
    label: "Self-hosted host…",
    value: "self_hosted",
  },
];

const computerHint = (computer: AgentComputer): string =>
  COMPUTER_OPTIONS.find((option) => option.value === computer)?.hint ?? "";

/**
 * The computer, and the host it sits on. Read-only once the agent exists, like
 * the runtime; while creating, picking a remote backend asks which host, and a
 * self-hosted host that already has an agent cannot take a second (plan §3).
 */
function ComputerFields({
  agent,
  computer,
  hostId,
  hosts,
  onComputerChange,
  onHostChange,
}: {
  agent: Agent | null;
  computer: AgentComputer;
  hostId: string | null;
  hosts: ComputerHost[];
  onComputerChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  onHostChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
}) {
  if (agent) {
    const host = hosts.find((row) => row.id === agent.computerHostId) ?? null;
    return (
      <p className="m-0 text-[var(--ws-muted)] text-xs">
        Computer: {computerSummary(agent.computer, host?.name ?? null)}
      </p>
    );
  }

  const choices =
    computer === "cloudflare" ? [] : hostChoicesFor(hosts, computer);

  return (
    <>
      <SelectField
        data-testid="agent-computer"
        hint={computerHint(computer)}
        label="Computer"
        onChange={onComputerChange}
        value={computer}
      >
        {COMPUTER_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
      {computer === "cloudflare" ? null : (
        <SelectField
          data-testid="agent-computer-host"
          disabled={choices.length === 0}
          hint={
            choices.length === 0
              ? "No host of this kind yet. Add one under Computers first."
              : "Where this agent's files and shell live. It cannot be changed later."
          }
          label="Host"
          onChange={onHostChange}
          required
          value={hostId ?? ""}
        >
          <option value="">Choose a host…</option>
          {choices.map((choice) => (
            <option
              disabled={choice.disabledReason !== null}
              key={choice.host.id}
              value={choice.host.id}
            >
              {choice.host.name}
              {choice.disabledReason ? ` (${choice.disabledReason})` : ""}
            </option>
          ))}
        </SelectField>
      )}
    </>
  );
}

/**
 * The agent's settings, in sections (plan 5e): the dialog was already crowded
 * with the profile alone, and Phase 5 adds Skills next to Connectors. Adding a
 * section is appending to this array and a branch in the panel below.
 *
 * Only an agent that exists has sections - a new one has no id to assign
 * anything to yet, so creating stays the single profile form it always was.
 */
const SECTIONS = ["Profile", "Connectors", "Skills", "Slack"] as const;

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
  const api = useApi();

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
            computer: agent.computer,
            computerHostId: agent.computerHostId,
            instructions: agent.instructions,
            model: agent.model ?? null,
            name: agent.name,
            runtime: agent.runtime,
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
  const onModelChange = useCallback(
    (model: string | null) => setDraft((previous) => ({ ...previous, model })),
    []
  );
  const onComputerChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const { value } = event.target;
      if (!isAgentComputer(value)) {
        return;
      }
      // A host belongs to one kind of computer, so switching clears it.
      setDraft((previous) => ({
        ...previous,
        computer: value,
        computerHostId: null,
      }));
    },
    []
  );
  const onComputerHostChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) =>
      setDraft((previous) => ({
        ...previous,
        computerHostId: event.target.value || null,
      })),
    []
  );
  const onRuntimeChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const { value } = event.target;
      if (!isAgentRuntime(value)) {
        return;
      }
      // A model belongs to one runtime's catalog, so switching clears it.
      setDraft((previous) => ({ ...previous, model: null, runtime: value }));
    },
    []
  );

  const runtime: AgentRuntime = agent?.runtime ?? draft.runtime ?? "managed";
  const computer: AgentComputer = draft.computer ?? "cloudflare";
  // Named even for an agent that already exists: the read-only line names its
  // host, and a member may open this dialog without ever seeing the Computers
  // screen.
  const { hosts } = useComputerHosts(open);
  // Connectors are attached to Managed Agents sessions; the Cloudflare runtime
  // has nowhere to attach them, so the tab would only mislead.
  const sections = SECTIONS.filter(
    (name) => name !== "Connectors" || runtime === "managed"
  );

  const rotate = useCallback(async () => {
    if (!agent) {
      return;
    }
    setRotating(true);
    try {
      const issued = await api.rotateAgentMcpToken(agent.id);
      onTokenIssued(agent.id, issued.mcpUrl);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to rotate the token."
      );
    } finally {
      setRotating(false);
    }
  }, [agent, api, onTokenIssued]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      try {
        let saved: Agent;
        if (agent) {
          saved = await api.updateAgent(agent.id, draft);
        } else {
          const issued = await api.createAgent(draft);
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
    [agent, api, draft, onClose, onSaved, onTokenIssued]
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
          {sections.map((name) => (
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

      {agent && section === "Skills" ? (
        <div role="tabpanel">
          <AgentSkillsPicker agentId={agent.id} />
        </div>
      ) : null}

      {agent && section === "Slack" ? (
        <div role="tabpanel">
          <AgentSlackPanel agentId={agent.id} />
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
          <p className="m-0 text-[var(--ws-muted)] text-xs">
            Runtime:{" "}
            {RUNTIME_OPTIONS.find((option) => option.value === runtime)?.label}
          </p>
        ) : (
          <SelectField
            data-testid="agent-runtime"
            hint={runtimeHint(runtime)}
            label="Runtime"
            onChange={onRuntimeChange}
            value={runtime}
          >
            {RUNTIME_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectField>
        )}
        <ComputerFields
          agent={agent}
          computer={computer}
          hostId={draft.computerHostId ?? null}
          hosts={hosts}
          onComputerChange={onComputerChange}
          onHostChange={onComputerHostChange}
        />
        {runtime === "cloudflare" ? (
          <CloudflareModelField
            onChange={onModelChange}
            value={draft.model ?? null}
          />
        ) : (
          <ModelSelect
            defaultLabel={WORKSPACE_DEFAULT_MODEL_LABEL}
            hint="Which model this agent thinks with."
            onChange={onModelChange}
            testId="agent-model"
            value={draft.model ?? null}
          />
        )}

        {agent && runtime === "managed" ? (
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
