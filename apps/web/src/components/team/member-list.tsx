import type { TeamMemberKind } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useCallback, useId, useState } from "react";
import { AVATAR_CLASSES } from "#/components/roster/roster-logic.ts";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils.ts";
import { AddMemberForm } from "./add-member-form.tsx";
import {
  type MemberRow,
  type TeamAgent,
  type TeamPerson,
  UNKNOWN_AGENT,
} from "./team-logic.ts";

const UNKNOWN_GLYPH = "?";

function AgentAvatar({ row }: { row: MemberRow }) {
  const color = row.avatar === null ? "slate" : row.avatar.color;
  const glyph = row.avatar === null ? UNKNOWN_GLYPH : row.avatar.glyph;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-lg font-semibold text-white",
        AVATAR_CLASSES[color]
      )}
    >
      {glyph}
    </span>
  );
}

function PersonAvatar({ label }: { label: string }) {
  const [initial = UNKNOWN_GLYPH] = Array.from(label);
  return (
    <span
      aria-hidden="true"
      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-foreground"
    >
      {initial}
    </span>
  );
}

function MemberName({ row }: { row: MemberRow }) {
  if (row.kind === "agent" && row.label !== UNKNOWN_AGENT) {
    return (
      <Link
        className="truncate font-medium text-foreground underline-offset-4 hover:underline"
        params={{ agentId: row.id }}
        to="/agents/$agentId"
      >
        {row.label}
      </Link>
    );
  }
  return <span className="truncate font-medium">{row.label}</span>;
}

function MemberRowItem({
  busy,
  canEdit,
  onRemove,
  row,
}: {
  busy: boolean;
  canEdit: boolean;
  onRemove: (row: MemberRow) => void;
  row: MemberRow;
}) {
  const remove = useCallback(() => onRemove(row), [onRemove, row]);
  return (
    <li className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card p-3 text-card-foreground">
      {row.kind === "agent" ? (
        <AgentAvatar row={row} />
      ) : (
        <PersonAvatar label={row.label} />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <MemberName row={row} />
          {row.isLead ? (
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs">
              Lead
            </span>
          ) : null}
          {row.isYou ? (
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs">
              You
            </span>
          ) : null}
        </div>
        {row.detail === "" ? null : (
          <span className="line-clamp-2 block text-muted-foreground text-sm">
            {row.detail}
          </span>
        )}
      </div>
      {canEdit ? (
        <Button
          aria-label={`Remove ${row.label} from the team`}
          disabled={busy}
          onClick={remove}
          size="sm"
          variant="outline"
        >
          Remove
        </Button>
      ) : null}
    </li>
  );
}

/** The team's members, with remove buttons and forms to add an agent or a person. */
export function MemberList({
  addableAgents,
  addablePeople,
  busy,
  canEdit,
  onAdd,
  onRemove,
  rows,
}: {
  addableAgents: readonly TeamAgent[];
  addablePeople: readonly TeamPerson[];
  busy: boolean;
  canEdit: boolean;
  onAdd: (kind: TeamMemberKind, id: string) => void;
  onRemove: (row: MemberRow) => void;
  rows: readonly MemberRow[];
}) {
  const idPrefix = useId();
  const [agentChoice, setAgentChoice] = useState("");
  const [personChoice, setPersonChoice] = useState("");

  // A choice that is no longer addable (someone else added it) counts as no choice.
  const chosenAgent = addableAgents.some((agent) => agent.id === agentChoice)
    ? agentChoice
    : "";
  const chosenPerson = addablePeople.some(
    (person) => person.userId === personChoice
  )
    ? personChoice
    : "";

  const submitAgent = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (busy || chosenAgent === "") {
        return;
      }
      onAdd("agent", chosenAgent);
      setAgentChoice("");
    },
    [busy, chosenAgent, onAdd]
  );

  const submitPerson = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (busy || chosenPerson === "") {
        return;
      }
      onAdd("user", chosenPerson);
      setPersonChoice("");
    },
    [busy, chosenPerson, onAdd]
  );

  const noneToAdd = addableAgents.length === 0 && addablePeople.length === 0;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No members yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <MemberRowItem
              busy={busy}
              canEdit={canEdit}
              key={`${row.kind}-${row.id}`}
              onRemove={onRemove}
              row={row}
            />
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="flex flex-col gap-4 border-border border-t pt-4">
          {addableAgents.length === 0 ? null : (
            <AddMemberForm
              busy={busy}
              choice={chosenAgent}
              choices={addableAgents.map((agent) => ({
                id: agent.id,
                label: agent.name,
              }))}
              onChange={setAgentChoice}
              onSubmit={submitAgent}
              placeholder="Choose an agent"
              selectId={`${idPrefix}-agent`}
              title="Add an agent"
            />
          )}
          {addablePeople.length === 0 ? null : (
            <AddMemberForm
              busy={busy}
              choice={chosenPerson}
              choices={addablePeople.map((person) => ({
                id: person.userId,
                label: person.name,
              }))}
              onChange={setPersonChoice}
              onSubmit={submitPerson}
              placeholder="Choose a person"
              selectId={`${idPrefix}-person`}
              title="Add a person"
            />
          )}
          {noneToAdd ? (
            <p className="text-muted-foreground text-sm">
              Everyone in the workspace is already in this team.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
