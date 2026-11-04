import {
  type DeskCard,
  NEEDS_YOU_HEADINGS,
  type NeedsYouKind,
} from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { GrantApprovalCard } from "#/components/artifacts/grant-approval-card.tsx";
import {
  buildGrantApproval,
  type PromoteApproval,
  parsePromoteApproval,
} from "#/components/artifacts/grant-approval-model.ts";
import { A2aDecision } from "#/components/connections/a2a-decision.tsx";
import { RequestCard } from "#/components/requests/request-card.tsx";
import type {
  AnswerPayload,
  RequestView,
} from "#/components/requests/request-card-logic.ts";
import {
  agentInitials,
  agentTileColour,
} from "#/components/shell/agent-tile.ts";
import { errorMessage } from "#/components/triggers/format.ts";
import { Button, buttonVariants } from "#/components/ui/button.tsx";
import { SuggestionReview } from "#/components/wiki-suggestions/suggestion-review.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { ConflictResolver } from "./conflict-resolver.tsx";
import { ProposalActions } from "./proposal-actions.tsx";

const BOX_CLASS =
  "flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm";

const headingFor = (agentName: string, kind: NeedsYouKind | undefined) =>
  kind === undefined ? agentName : NEEDS_YOU_HEADINGS[kind](agentName);

function OpenTaskLink({ runId }: { runId: string }) {
  return (
    <Link
      className={buttonVariants({ size: "sm", variant: "outline" })}
      params={{ runId }}
      to="/tasks/$runId"
    >
      Open task
    </Link>
  );
}

function CardSummary({ card }: { card: DeskCard }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="font-semibold">{card.title}</p>
      <p className="text-muted-foreground text-xs">{card.band.text}</p>
    </div>
  );
}

/** An ask whose request is not loaded: the title, and a way to the task. */
function AskFallback({ card }: { card: DeskCard }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <CardSummary card={card} />
      {card.runId === undefined ? null : <OpenTaskLink runId={card.runId} />}
    </div>
  );
}

export function ThreadBody({
  card,
  onChanged,
}: {
  card: DeskCard;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismiss = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await getTrpc().inbox.clearAttention.mutate({ threadId: card.id });
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }, [card.id, onChanged]);

  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-muted-foreground text-xs">{card.band.text}</p>
      <div className="flex flex-wrap gap-2">
        <Link
          className={buttonVariants({ size: "sm", variant: "outline" })}
          search={{ thread: card.id }}
          to="/inbox"
        >
          Open thread
        </Link>
        <Button
          disabled={pending}
          onClick={dismiss}
          size="sm"
          type="button"
          variant="outline"
        >
          Dismiss
        </Button>
      </div>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** A person reviews the version named by the grant card. */
export function PersonAppGrants({
  card,
  nowMs,
  onChanged,
}: {
  card: DeskCard;
  nowMs: number;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<PromoteApproval | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!card.artifactId) {
        return;
      }
      const trpc = getTrpc();
      const [artifact, grants, agents, versions] = await Promise.all([
        trpc.artifacts.get.query({ artifactId: card.artifactId }),
        trpc.artifacts.grants.query({
          artifactId: card.artifactId,
          versionId: card.id,
        }),
        trpc.agents.list.query({}),
        trpc.artifacts.versions.query({ artifactId: card.artifactId }),
      ]);
      const version = versions.find((item) => item.id === card.id);
      if (!version) {
        throw new Error("Version not found, reload.");
      }
      const parsed = buildGrantApproval({
        artifactId: card.artifactId,
        grants: grants
          .filter((grant) => grant.status === "pending")
          .map((grant) => ({
            ...grant,
            name:
              agents.find((agent) => agent.id === grant.target)?.name ??
              "Unavailable agent",
          })),
        title: artifact.title,
        version: version.number,
        versionId: card.id,
      });
      if (active) {
        setItems(parsed);
      }
    };
    load().catch((cause) => {
      if (active) {
        setError(errorMessage(cause));
      }
    });
    return () => {
      active = false;
    };
  }, [card.artifactId, card.id]);
  if (error) {
    return <p role="alert">{error}</p>;
  }
  return items ? (
    <div className="flex flex-col gap-3">
      <GrantApprovalCard items={items} nowMs={nowMs} onChanged={onChanged} />
      <a
        className={buttonVariants({ size: "sm", variant: "outline" })}
        href={`/a/${items.artifactId}`}
      >
        See app
      </a>
    </div>
  ) : (
    <p>Loading app access…</p>
  );
}

interface NeedsYouBodyProps {
  agentName: string;
  card: DeskCard;
  nowMs: number;
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
  onChanged: () => void;
  request: RequestView | null;
  /** Replaces an approval's raw "Use <tool>" line. */
  title?: string;
  version: { number: number; skillId: string } | null;
}

/** What a Needs you card asks, by kind. The desk and the rail pane both draw it. */
export function NeedsYouBody({
  agentName,
  card,
  nowMs,
  onAnswer,
  onChanged,
  request,
  title,
  version,
}: NeedsYouBodyProps) {
  switch (card.needsYouKind) {
    case "approval":
      if (request?.kind === "approval") {
        const promote = parsePromoteApproval(request.display);
        if (promote !== null) {
          return (
            <GrantApprovalCard
              expiresAt={request.expiresAt}
              items={promote}
              nowMs={nowMs}
              onChanged={onChanged}
            />
          );
        }
      }
      return request === null ? (
        <AskFallback card={card} />
      ) : (
        <RequestCard
          nowMs={nowMs}
          onAnswer={onAnswer}
          onClosed={onChanged}
          title={title}
          view={request}
        />
      );
    case "question":
    case "takeover":
      return request === null ? (
        <AskFallback card={card} />
      ) : (
        <RequestCard
          nowMs={nowMs}
          onAnswer={onAnswer}
          onClosed={onChanged}
          view={request}
        />
      );
    case "artifact_grant":
      return (
        <PersonAppGrants card={card} nowMs={nowMs} onChanged={onChanged} />
      );
    case "skill_proposal":
    case "trigger_proposal":
    case "routine_proposal":
      return (
        <div className="flex flex-col gap-3">
          <CardSummary card={card} />
          <ProposalActions
            card={card}
            onChanged={onChanged}
            version={version}
          />
        </div>
      );
    case "inbox_reply":
      return <ThreadBody card={card} onChanged={onChanged} />;
    case "wiki_suggestion":
      return (
        <SuggestionReview
          agentName={agentName}
          id={card.id}
          onDecided={onChanged}
        />
      );
    case "library_conflict":
      return <ConflictResolver card={card} onChanged={onChanged} />;
    case "a2a_message":
    case "a2a_connection":
      return <A2aDecision card={card} onChanged={onChanged} />;
    default:
      return <CardSummary card={card} />;
  }
}

/** A card in the Needs you lane: an ask, a proposal or a thread reply that waits on a person. */
export function NeedsYouCard({
  agentName,
  card,
  nowMs,
  onAnswer,
  onChanged,
  request,
  version,
}: {
  agentName: string;
  card: DeskCard;
  nowMs: number;
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
  onChanged: () => void;
  request: RequestView | null;
  version: { number: number; skillId: string } | null;
}) {
  return (
    <section
      className={BOX_CLASS}
      data-kind={card.needsYouKind}
      data-testid="needs-you-card"
    >
      <header className="flex items-center gap-2.5">
        <span
          className={`grid size-[30px] shrink-0 place-items-center rounded-lg font-bold text-white text-xs ${agentTileColour(agentName)}`}
        >
          {agentInitials(agentName)}
        </span>
        <h3 className="font-semibold">
          {headingFor(agentName, card.needsYouKind)}
        </h3>
      </header>
      <NeedsYouBody
        agentName={agentName}
        card={card}
        nowMs={nowMs}
        onAnswer={onAnswer}
        onChanged={onChanged}
        request={request}
        title={card.title}
        version={version}
      />
    </section>
  );
}
