import type { RailItem, RailScope, RailSetupStep } from "@repo/db/shared";
import {
  agentInitials,
  agentTileColour,
} from "#/components/shell/agent-tile.ts";
import { cn } from "#/lib/utils";
import { RailLink } from "./rail-link.tsx";
import { dueLabel, extraCardsLabel } from "./rail-logic.ts";

const SETUP_ROWS: Readonly<
  Record<RailSetupStep, { href: string; status: string; title: string }>
> = {
  ai_account: {
    href: "/settings/model-providers",
    status: "Agents need it to run",
    title: "Add your AI account",
  },
  first_agent: {
    href: "/agents/new",
    status: "Takes a minute",
    title: "Describe your first job",
  },
};

const ROW_CLASS =
  "block min-h-10 rounded-lg border border-border border-l-[3px] bg-card px-2.5 py-2 text-sm no-underline hover:border-input";

function AgentTile({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-[1.125rem] shrink-0 items-center justify-center rounded font-semibold text-[9px] text-white",
        agentTileColour(name)
      )}
    >
      {agentInitials(name)}
    </span>
  );
}

export function SetupRow({
  onNavigate,
  step,
}: {
  onNavigate: () => void;
  step: RailSetupStep;
}) {
  const row = SETUP_ROWS[step];
  return (
    <RailLink
      className={cn(ROW_CLASS, "border-l-primary")}
      href={row.href}
      onNavigate={onNavigate}
    >
      <span className="block font-medium text-foreground leading-snug">
        {row.title}
      </span>
      <span className="mt-0.5 block text-muted-foreground text-xs">
        {row.status}
      </span>
    </RailLink>
  );
}

export function NeedsYouRow({
  fresh,
  item,
  now,
  onNavigate,
  open,
  scope,
}: {
  fresh: boolean;
  item: RailItem;
  now: Date;
  onNavigate: () => void;
  open: boolean;
  scope: RailScope;
}) {
  const [first] = item.cards;
  if (first === undefined) {
    return null;
  }
  const due = dueLabel(item.dueAt, now);
  const extra = extraCardsLabel(item.cards.length);
  return (
    <RailLink
      className={cn(
        ROW_CLASS,
        first.kind === "problem" ? "border-l-destructive" : "border-l-primary",
        open && "bg-accent",
        fresh && "rise-in"
      )}
      current={open}
      href={`/desk?item=${encodeURIComponent(item.id)}`}
      onNavigate={onNavigate}
    >
      <span className="block font-medium text-foreground leading-snug">
        {first.title}
      </span>
      <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground text-xs">
        {first.agentName === "" ? null : <AgentTile name={first.agentName} />}
        {due === null ? null : (
          <span className="font-medium text-primary">{due}</span>
        )}
        <span>{first.status}</span>
        {extra === null ? null : (
          <span className="rounded-full bg-muted px-1.5">{extra}</span>
        )}
        {scope === "everyone" && item.assigneeName !== null ? (
          <span>for {item.assigneeName}</span>
        ) : null}
        {item.escalatedToMe ? (
          <span className="font-medium text-primary">asked you too</span>
        ) : null}
      </span>
    </RailLink>
  );
}
