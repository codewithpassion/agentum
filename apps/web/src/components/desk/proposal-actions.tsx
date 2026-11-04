import type { DeskCard } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { errorMessage } from "#/components/triggers/format.ts";
import { Button, buttonVariants } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";

type Decision = "approve" | "reject";

interface ProposalVersion {
  number: number;
  skillId: string;
}

const VERSION_MISSING = "Version not found, reload.";

/** Sends an approve or reject to the procedure the proposal's kind names. */
const sendDecision = (
  card: DeskCard,
  version: ProposalVersion | null,
  decision: Decision
): Promise<unknown> => {
  const trpc = getTrpc();
  switch (card.needsYouKind) {
    case "skill_proposal": {
      if (version === null) {
        throw new Error(VERSION_MISSING);
      }
      const input = { skillId: version.skillId, version: version.number };
      return decision === "approve"
        ? trpc.skillStore.approve.mutate(input)
        : trpc.skillStore.reject.mutate(input);
    }
    case "trigger_proposal": {
      const input = { triggerId: card.id };
      return decision === "approve"
        ? trpc.triggers.approve.mutate(input)
        : trpc.triggers.reject.mutate(input);
    }
    case "routine_proposal": {
      const input = { routineId: card.id };
      return decision === "approve"
        ? trpc.routines.approve.mutate(input)
        : trpc.routines.reject.mutate(input);
    }
    default:
      throw new Error("Not a proposal.");
  }
};

function SeeChanges({
  card,
  version,
}: {
  card: DeskCard;
  version: ProposalVersion | null;
}) {
  if (card.needsYouKind === "skill_proposal") {
    if (version === null) {
      return (
        <Button disabled size="sm" variant="outline">
          See changes
        </Button>
      );
    }
    return (
      <Link
        className={buttonVariants({ size: "sm", variant: "outline" })}
        params={{ skillId: version.skillId }}
        to="/skills/$skillId"
      >
        See changes
      </Link>
    );
  }
  if (card.needsYouKind === "trigger_proposal") {
    return (
      <Link
        className={buttonVariants({ size: "sm", variant: "outline" })}
        to="/triggers"
      >
        See changes
      </Link>
    );
  }
  return (
    <Link
      className={buttonVariants({ size: "sm", variant: "outline" })}
      to="/routines"
    >
      See changes
    </Link>
  );
}

/** Approve, see changes and reject for a skill, trigger or routine proposal. */
export function ProposalActions({
  card,
  onChanged,
  version,
}: {
  card: DeskCard;
  onChanged: () => void;
  version: ProposalVersion | null;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (decision: Decision) => {
      setPending(true);
      setError(null);
      try {
        await sendDecision(card, version, decision);
        onChanged();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setPending(false);
      }
    },
    [card, version, onChanged]
  );

  const approve = useCallback(() => run("approve"), [run]);
  const reject = useCallback(() => run("reject"), [run]);

  const isSkill = card.needsYouKind === "skill_proposal";
  const versionMissing = isSkill && version === null;
  const approveLabel =
    isSkill && version !== null ? `Approve v${version.number}` : "Approve";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2 pointer-coarse:gap-3">
        <Button
          disabled={pending || versionMissing}
          onClick={approve}
          size="sm"
          type="button"
        >
          {approveLabel}
        </Button>
        <SeeChanges card={card} version={version} />
        <Button
          disabled={pending || versionMissing}
          onClick={reject}
          size="sm"
          type="button"
          variant="outline"
        >
          Reject
        </Button>
      </div>
      {versionMissing ? (
        <p className="text-muted-foreground text-xs">{VERSION_MISSING}</p>
      ) : null}
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
