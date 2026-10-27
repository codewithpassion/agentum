import { Link } from "@tanstack/react-router";
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ConfirmButton } from "#/components/confirm-action/confirm-button";
import { errorMessage } from "#/components/library/library-logic.ts";
import {
  type AssignedSkill,
  agentAssignments,
  agentProposals,
  approvedVersions,
  assignableSkills,
  assignedSkills,
  assignLabel,
  pinChoice,
  pinValue,
} from "#/components/skills/agent-skills-logic.ts";
import {
  type AgentNames,
  versionLabel,
} from "#/components/skills/skills-logic.ts";
import { Button } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type {
  AgentSkill,
  SkillAssignment,
  SkillSummary,
  SkillVersion,
} from "#/integrations/trpc/types";
import type { AgentPanelProps } from "./props.ts";

const SELECT_CLASS =
  "h-10 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-8 max-md:max-w-full max-md:min-w-0";

interface SkillsData {
  agentNames: AgentNames;
  /** This agent's assignments only. */
  assignments: SkillAssignment[];
  proposals: SkillVersion[];
  resolved: AgentSkill[];
  skills: SkillSummary[];
}

const loadSkills = async (agentId: string): Promise<SkillsData> => {
  const trpc = getTrpc();
  const [assignments, skills, resolved, proposals, agents] = await Promise.all([
    trpc.skillStore.assignments.query(),
    trpc.skillStore.list.query(),
    trpc.skillStore.forAgent.query({ agentId }),
    trpc.skillStore.proposals.query(),
    trpc.agents.list.query({ includeArchived: true }),
  ]);
  return {
    agentNames: new Map(agents.map((agent) => [agent.id, agent.name])),
    assignments: agentAssignments(assignments, agentId),
    proposals,
    resolved,
    skills,
  };
};

function AssignedRow({
  row,
  onPin,
  onUnassign,
}: {
  row: AssignedSkill;
  onPin: (skillId: string, value: string) => void;
  onUnassign: (skillId: string) => void;
}) {
  const { skillId } = row;
  const [versions, setVersions] = useState<number[]>([]);
  const [logError, setLogError] = useState<string | undefined>();

  useEffect(() => {
    let current = true;
    getTrpc()
      .skillStore.log.query({ skillId })
      .then((log) => {
        if (current) {
          setVersions(approvedVersions(log));
          setLogError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          setLogError(errorMessage(cause));
        }
      });
    return () => {
      current = false;
    };
  }, [skillId]);

  const changePin = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      onPin(skillId, event.target.value),
    [onPin, skillId]
  );
  const unassign = useCallback(
    () => onUnassign(skillId),
    [onUnassign, skillId]
  );

  let versionText = "No approved version yet";
  if (row.version !== null) {
    versionText = versionLabel(row.version, row.pinned);
  }

  return (
    <li className="flex flex-col gap-2 py-3" data-testid="agent-skill-row">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Link
          className="font-medium text-foreground hover:text-primary"
          params={{ skillId }}
          to="/skills/$skillId"
        >
          {row.name}
        </Link>
        <span className="text-muted-foreground text-sm">{row.owner}</span>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>{versionText}</span>
        {row.pinned ? null : (
          <span className="text-muted-foreground">follows latest approved</span>
        )}
        <label className="flex items-center gap-2 max-md:min-w-0 max-md:max-w-full">
          Version
          <select
            className={SELECT_CLASS}
            data-testid="agent-skill-pin"
            onChange={changePin}
            value={pinValue(row.pinnedVersion)}
          >
            <option value="">Latest approved (follow)</option>
            {versions.map((number) => (
              <option key={number} value={number}>
                {versionLabel(number)}
              </option>
            ))}
          </select>
        </label>
        <ConfirmButton
          confirmLabel="Unassign"
          data-testid="agent-skill-unassign"
          description={`${row.name} stops applying to this agent. You can assign it again later.`}
          onConfirm={unassign}
          size="sm"
          title={`Unassign ${row.name}?`}
          type="button"
          variant="outline"
        >
          Unassign
        </ConfirmButton>
      </div>
      {logError === undefined ? null : (
        <p className="text-destructive text-sm">{logError}</p>
      )}
    </li>
  );
}

function AgentSkills({ agentId }: { agentId: string }) {
  const [data, setData] = useState<SkillsData | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [choice, setChoice] = useState("");
  // The agent this panel shows. Null after unmount, so a late response is dropped.
  const shownAgent = useRef<string | null>(null);

  useEffect(() => {
    shownAgent.current = agentId;
    return () => {
      shownAgent.current = null;
    };
  }, [agentId]);

  const reload = useCallback(() => {
    loadSkills(agentId)
      .then((next) => {
        if (shownAgent.current === agentId) {
          setData(next);
          setLoadError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (shownAgent.current === agentId) {
          setLoadError(errorMessage(cause));
        }
      });
  }, [agentId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Runs one change, then reloads. Resolves to false when the change failed.
  const runChange = useCallback(
    async (change: () => Promise<unknown>): Promise<boolean> => {
      setActionError(undefined);
      try {
        await change();
      } catch (cause) {
        if (shownAgent.current === agentId) {
          setActionError(errorMessage(cause));
        }
        return false;
      }
      reload();
      return true;
    },
    [agentId, reload]
  );

  const changeChoice = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => setChoice(event.target.value),
    []
  );

  const assignChosen = useCallback(async () => {
    if (choice === "") {
      return;
    }
    const assigned = await runChange(() =>
      getTrpc().skillStore.assign.mutate({ agentId, skillId: choice })
    );
    if (assigned) {
      setChoice("");
    }
  }, [agentId, choice, runChange]);

  const changePin = useCallback(
    async (skillId: string, value: string) => {
      await runChange(() =>
        getTrpc().skillStore.pin.mutate({
          agentId,
          skillId,
          version: pinChoice(value),
        })
      );
    },
    [agentId, runChange]
  );

  const unassign = useCallback(
    async (skillId: string) => {
      await runChange(() =>
        getTrpc().skillStore.unassign.mutate({ agentId, skillId })
      );
    },
    [agentId, runChange]
  );

  let assignedBody: ReactNode;
  let assignOptions: ReactNode = null;
  let proposalsBody: ReactNode = null;
  if (data === undefined) {
    assignedBody =
      loadError === undefined ? (
        <p className="text-muted-foreground text-sm">Loading skills.</p>
      ) : null;
  } else {
    const rows = assignedSkills(
      data.assignments,
      data.skills,
      data.resolved,
      data.agentNames
    );
    const options = assignableSkills(data.skills, data.assignments);
    const proposals = agentProposals(
      data.proposals,
      data.skills,
      agentId,
      data.agentNames
    );

    assignedBody =
      rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No skills assigned.</p>
      ) : (
        <ul className="divide-y divide-border border-border border-y">
          {rows.map((row) => (
            <AssignedRow
              key={row.skillId}
              onPin={changePin}
              onUnassign={unassign}
              row={row}
            />
          ))}
        </ul>
      );

    assignOptions = (
      <>
        <label className="flex flex-col gap-1 text-sm">
          Skill
          <select
            className={SELECT_CLASS}
            data-testid="agent-skill-assign-select"
            onChange={changeChoice}
            value={choice}
          >
            <option value="">Choose a skill</option>
            {options.map((skill) => (
              <option key={skill.id} value={skill.id}>
                {assignLabel(skill, data.agentNames)}
              </option>
            ))}
          </select>
        </label>
        <Button
          data-testid="agent-skill-assign"
          disabled={choice === ""}
          onClick={assignChosen}
          type="button"
        >
          Assign
        </Button>
      </>
    );

    proposalsBody =
      proposals.length === 0 ? (
        <p className="text-muted-foreground text-sm">No pending proposals.</p>
      ) : (
        <ul className="divide-y divide-border border-border border-y">
          {proposals.map((proposal) => (
            <li
              className="flex items-center justify-between gap-4 py-3"
              data-testid="agent-skill-proposal"
              key={proposal.key}
            >
              <span className="text-sm">
                {`${proposal.name} (${proposal.owner}) v${proposal.version}: ${proposal.message}`}
              </span>
              <Link
                className="shrink-0 text-sm underline hover:text-primary"
                params={{ skillId: proposal.skillId }}
                search={{ tab: "history" }}
                to="/skills/$skillId"
              >
                Review
              </Link>
            </li>
          ))}
        </ul>
      );
  }

  return (
    <section className="flex max-w-3xl flex-col gap-6">
      <p className="text-muted-foreground text-sm">
        Skills are managed on the{" "}
        <Link className="underline hover:text-primary" to="/skills">
          Skills page
        </Link>
        .
      </p>
      {loadError === undefined ? null : (
        <p className="text-destructive text-sm">{loadError}</p>
      )}
      {actionError === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {actionError}
        </p>
      )}

      <div className="flex flex-col gap-3">
        <h3 className="font-medium">Assigned skills</h3>
        {assignedBody}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="font-medium">Assign a skill</h3>
        <div className="flex flex-wrap items-end gap-3">{assignOptions}</div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="font-medium">Proposed by this agent</h3>
        {proposalsBody}
      </div>
    </section>
  );
}

export function SkillsPanel({ agent }: AgentPanelProps) {
  return <AgentSkills agentId={agent.id} key={agent.id} />;
}
