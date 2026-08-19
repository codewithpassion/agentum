import { useCallback } from "react";
import { Avatar } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import type { Agent } from "#/lib/api";

/** Phase 3 fills these with the agent's computer and browser (see docs/plan.md). */
const PLACEHOLDER_TABS = ["Screen", "Files", "Activity"] as const;

function Section({ body, title }: { body: string; title: string }) {
  return (
    <section className="space-y-1">
      <h3 className="m-0 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
        {title}
      </h3>
      <p className="m-0 whitespace-pre-wrap text-[13px] text-[var(--ws-text)] leading-6">
        {body.length > 0 ? body : "—"}
      </p>
    </section>
  );
}

function AgentActions({
  agent,
  onDelete,
  onEdit,
}: {
  agent: Agent;
  onDelete: (agent: Agent) => void;
  onEdit: (agent: Agent) => void;
}) {
  const edit = useCallback(() => onEdit(agent), [agent, onEdit]);
  const remove = useCallback(() => onDelete(agent), [agent, onDelete]);

  return (
    <div className="flex gap-2">
      <Button onClick={edit} size="sm" variant="subtle">
        Edit
      </Button>
      <Button onClick={remove} size="sm" variant="danger">
        Delete
      </Button>
    </div>
  );
}

export function AgentRail({
  agent,
  onDelete,
  onEdit,
}: {
  agent: Agent | null;
  onDelete: (agent: Agent) => void;
  onEdit: (agent: Agent) => void;
}) {
  return (
    <aside
      className="hidden w-80 shrink-0 flex-col overflow-y-auto border-[var(--ws-line)] border-l bg-[var(--ws-panel)] lg:flex"
      data-testid="agent-rail"
    >
      {agent ? (
        <div className="space-y-5 p-4">
          <div className="flex items-center gap-3">
            <Avatar color={agent.avatar} name={agent.name} size="lg" />
            <div className="min-w-0">
              <p className="m-0 truncate font-semibold text-sm">{agent.name}</p>
              <p className="m-0 flex items-center gap-1.5 text-[var(--ws-muted)] text-xs">
                <span
                  aria-hidden="true"
                  className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--ws-muted)]"
                />
                idle
              </p>
            </div>
          </div>

          <nav aria-label="Agent screen">
            <ul className="m-0 flex list-none gap-1 rounded-lg bg-[var(--ws-surface)] p-1">
              {PLACEHOLDER_TABS.map((tab) => (
                <li className="flex-1" key={tab}>
                  <button
                    className="w-full cursor-not-allowed rounded-md px-2 py-1 text-[var(--ws-muted)] text-xs"
                    disabled
                    title="Available in phase 3"
                    type="button"
                  >
                    {tab}
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[var(--ws-muted)] text-xs">
              The agent's computer and browser land here in phase 3.
            </p>
          </nav>

          <Section body={agent.soul} title="Soul" />
          <Section body={agent.instructions} title="Instructions" />

          <AgentActions agent={agent} onDelete={onDelete} onEdit={onEdit} />
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="m-0 font-medium text-sm">No agent selected</p>
          <p className="m-0 text-[var(--ws-muted)] text-xs">
            Click an agent in the sidebar or on a message to see its profile.
          </p>
        </div>
      )}
    </aside>
  );
}
