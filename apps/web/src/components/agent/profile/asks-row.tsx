import type { WorkspaceMember } from "@repo/db/shared";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useId, useState } from "react";
import { toast } from "sonner";
import { Label } from "#/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { getTrpc } from "#/integrations/trpc/client";
import type { AgentRecord } from "#/integrations/trpc/types";
import {
  type AskChange,
  backupChoices,
  canPick,
  nextOwners,
  ownerIdOf,
} from "./asks-logic.ts";

/** Select values that stand for no user. Radix needs a string for each item. */
const NOBODY = "__nobody__";
const NO_BACKUP = "__no_backup__";

export function AsksRow({
  agent,
  members,
}: {
  agent: AgentRecord;
  members: WorkspaceMember[] | null;
}) {
  if (members === null) {
    return <p>Not available</p>;
  }
  if (!canPick(members)) {
    return <p>{members[0]?.name ?? "Nobody"}</p>;
  }
  return <AsksSelects agent={agent} members={members} />;
}

function AsksSelects({
  agent,
  members,
}: {
  agent: AgentRecord;
  members: WorkspaceMember[];
}) {
  const router = useRouter();
  const ownerSelectId = useId();
  const backupSelectId = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const owner = ownerIdOf(agent);
  const ownerKnown = members.some((member) => member.userId === owner);
  const choices = backupChoices(members, owner);
  let backupValue = NO_BACKUP;
  if (agent.backupUserId !== null) {
    backupValue = choices.some((member) => member.userId === agent.backupUserId)
      ? agent.backupUserId
      : NOBODY;
  }

  const save = useCallback(
    async (change: AskChange) => {
      const next = nextOwners({
        change,
        current: { backupUserId: agent.backupUserId, ownerUserId: owner },
        members,
      });
      setSaving(true);
      setError(undefined);
      try {
        await getTrpc().agents.setOwners.mutate({ id: agent.id, ...next });
        await router.invalidate();
        toast.success("Saved");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSaving(false);
      }
    },
    [agent.backupUserId, agent.id, members, owner, router]
  );

  const changeOwner = useCallback(
    (value: string) => save({ ownerUserId: value }),
    [save]
  );
  const changeBackup = useCallback(
    (value: string) =>
      save({ backupUserId: value === NO_BACKUP ? null : value }),
    [save]
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-1">
          <Label htmlFor={ownerSelectId}>Owner</Label>
          <Select
            disabled={saving}
            onValueChange={changeOwner}
            value={ownerKnown ? owner : NOBODY}
          >
            <SelectTrigger id={ownerSelectId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ownerKnown ? null : (
                <SelectItem disabled value={NOBODY}>
                  Nobody
                </SelectItem>
              )}
              {members.map((member) => (
                <SelectItem key={member.userId} value={member.userId}>
                  {member.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={backupSelectId}>Backup</Label>
          <Select
            disabled={saving}
            onValueChange={changeBackup}
            value={backupValue}
          >
            <SelectTrigger id={backupSelectId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_BACKUP}>No backup</SelectItem>
              {backupValue === NOBODY ? (
                <SelectItem disabled value={NOBODY}>
                  Nobody
                </SelectItem>
              ) : null}
              {choices.map((member) => (
                <SelectItem key={member.userId} value={member.userId}>
                  {member.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {error === undefined ? null : (
        <p className="text-destructive text-sm">{error}</p>
      )}
    </div>
  );
}
