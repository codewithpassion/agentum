import type { DeskCard } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { errorMessage } from "#/components/triggers/format.ts";
import { Button, buttonVariants } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { approvalSeen } from "./approval-seen.ts";

type Decision = "approve" | "decline";

const NO_ORIGIN =
  "This connection has no address to approve yet. Open it to look.";

/** The connection a card is about. A connection card's own id is the connection's. */
const connectionIdOf = ({ a2a, id }: DeskCard): string =>
  a2a === undefined ? id : a2a.connectionId;

/**
 * Approves or declines one thing a peer asked for: a message that waits, or a
 * connection. A connection is approved with the destination a fresh read of it
 * shows, which is the one the card names.
 */
const decide = async (card: DeskCard, decision: Decision): Promise<void> => {
  const trpc = getTrpc();
  if (card.needsYouKind === "a2a_message") {
    if (decision === "approve") {
      await trpc.a2a.approveMessage.mutate({ taskId: card.id });
    } else {
      await trpc.a2a.declineMessage.mutate({ taskId: card.id });
    }
    return;
  }
  const connectionId = connectionIdOf(card);
  if (decision === "decline") {
    await trpc.a2a.decline.mutate({ connectionId });
    return;
  }
  const seen = approvalSeen(await trpc.a2a.get.query({ connectionId }));
  if (seen === null) {
    throw new Error(NO_ORIGIN);
  }
  await trpc.a2a.approve.mutate({ connectionId, seen });
};

/** Who is asking, as plain text. Every part of it came from the peer. */
function Asking({ card }: { card: DeskCard }) {
  const { a2a } = card;
  if (a2a === undefined) {
    return null;
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted-foreground">From</dt>
      <dd className="min-w-0 break-words font-medium">{a2a.peer}</dd>
      <dt className="text-muted-foreground">Host</dt>
      <dd className="min-w-0 break-words">{a2a.host ?? "not known"}</dd>
      {a2a.org === null ? null : (
        <>
          <dt className="text-muted-foreground">Organisation</dt>
          <dd className="min-w-0 break-words">{a2a.org} (as it claims)</dd>
        </>
      )}
      {a2a.checkCode === null ? null : (
        <>
          <dt className="text-muted-foreground">Check code</dt>
          <dd className="font-mono tracking-widest" data-testid="check-code">
            {a2a.checkCode}
          </dd>
        </>
      )}
    </dl>
  );
}

/** Needs you body for a waiting message (`a2a_message`) and a pending connection (`a2a_connection`). */
export function A2aDecision({
  card,
  onChanged,
}: {
  card: DeskCard;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMessage = card.needsYouKind === "a2a_message";
  const text = card.a2a?.text;

  const run = useCallback(
    async (decision: Decision) => {
      setPending(true);
      setError(null);
      try {
        await decide(card, decision);
        onChanged();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setPending(false);
      }
    },
    [card, onChanged]
  );
  const approve = useCallback(() => run("approve"), [run]);
  const decline = useCallback(() => run("decline"), [run]);

  return (
    <div className="flex flex-col gap-3">
      <Asking card={card} />
      {isMessage && typeof text === "string" ? (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs">
            What it sent. This is outside input, shown as plain text.
          </p>
          <pre
            className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-sans text-sm"
            data-testid="a2a-message-text"
          >
            {text}
          </pre>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2 pointer-coarse:gap-3">
        <Button disabled={pending} onClick={approve} size="sm" type="button">
          Approve
        </Button>
        <Button
          disabled={pending}
          onClick={decline}
          size="sm"
          type="button"
          variant="outline"
        >
          Decline
        </Button>
        {isMessage ? null : (
          <Link
            className={buttonVariants({ size: "sm", variant: "ghost" })}
            params={{ connectionId: connectionIdOf(card) }}
            to="/settings/agent-connections/$connectionId"
          >
            Look at it first
          </Link>
        )}
      </div>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
