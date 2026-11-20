import { useAuth } from "@clerk/tanstack-react-start";
import { type SpendRow, sumSpendCents } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useState,
} from "react";
import { Button, buttonVariants } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import {
  capInputValue,
  capLabel,
  capLine,
  parseCapInput,
  spendWeeks,
} from "./spend-logic.ts";

export interface SpendPauseViewProps {
  /** The agent's own week-to-date is at or over its limit, so Resume would run once and pause again. */
  atLimit: boolean;
  busy: boolean;
  error: string | null;
  isAdmin: boolean;
  /** "$1.05 of $1 this week", "The limit is $20 a week.", or null when it is not known. */
  limitText: string | null;
  onRaiseChange: (value: string) => void;
  onRaiseOpen: () => void;
  onRaiseSubmit: () => void;
  onResume: () => void;
  raiseValue: string;
  raising: boolean;
  /** Set when the workspace limit, not the agent's own, is what stopped it. Raising the agent's limit would not help. */
  workspaceLimitText: string | null;
}

/** An agent paused at its weekly limit: resume it, or raise the limit and resume. */
export function SpendPauseView({
  atLimit,
  busy,
  error,
  isAdmin,
  limitText,
  onRaiseChange,
  onRaiseOpen,
  onRaiseSubmit,
  onResume,
  raiseValue,
  raising,
  workspaceLimitText,
}: SpendPauseViewProps) {
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onRaiseChange(event.target.value),
    [onRaiseChange]
  );
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      onRaiseSubmit();
    },
    [onRaiseSubmit]
  );

  return (
    <div className="flex flex-col gap-3">
      {raising ? (
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="spend-pause-raise">
              New weekly limit in dollars
            </Label>
            <div className="flex max-w-xs items-center gap-2">
              <span aria-hidden="true" className="text-muted-foreground">
                $
              </span>
              <Input
                id="spend-pause-raise"
                inputMode="decimal"
                onChange={change}
                value={raiseValue}
              />
            </div>
          </div>
          <div>
            <Button disabled={busy} size="sm" type="submit">
              Raise and resume
            </Button>
          </div>
        </form>
      ) : (
        <>
          {(workspaceLimitText ?? limitText) === null ? null : (
            <p className="text-muted-foreground">
              {workspaceLimitText ?? limitText}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {(workspaceLimitText !== null && !isAdmin) ||
            (atLimit && workspaceLimitText === null) ? null : (
              <Button
                disabled={busy}
                onClick={onResume}
                size="sm"
                type="button"
              >
                Resume
              </Button>
            )}
            {workspaceLimitText === null ? (
              <Button
                disabled={busy}
                onClick={onRaiseOpen}
                size="sm"
                type="button"
                variant="outline"
              >
                Raise the limit
              </Button>
            ) : (
              <Link
                className={buttonVariants({ size: "sm", variant: "outline" })}
                to="/settings/spend"
              >
                Raise the workspace limit
              </Link>
            )}
          </div>
        </>
      )}
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const PAUSE_NEEDS_LIMIT = "Enter the new limit in dollars.";

const workspaceLimitMessage = (
  workspaceCents: number,
  isAdmin: boolean
): string => {
  const limit = capLabel(workspaceCents);
  if (!isAdmin) {
    return `The workspace limit of ${limit} a week is reached. Only raising the workspace limit lets this agent run, and an admin sets it.`;
  }
  return `The workspace limit of ${limit} a week is reached. Raising this agent's limit will not restart it.`;
};

const pauseLimitText = (
  limitCents: number | null,
  spentCents: number | null
): string | null => {
  if (limitCents === null) {
    return null;
  }
  return (
    (spentCents === null ? null : capLine(spentCents, limitCents)) ??
    `The limit is ${capLabel(limitCents)} a week.`
  );
};

/** The workspace total, and what counts against the agent: its own spend under its own limit, else the workspace total it runs under. */
const weekSpend = (
  rows: readonly SpendRow[],
  agentId: string,
  hasOwnCap: boolean
): { spentCents: number; totalCents: number } => {
  const totalCents = sumSpendCents(rows);
  if (!hasOwnCap) {
    return { spentCents: totalCents, totalCents };
  }
  const spentCents = sumSpendCents(
    rows.filter((row) => row.agentId === agentId)
  );
  return { spentCents, totalCents };
};

/** Loads the agent's limit, then resumes the agent, optionally with a new limit. */
export function SpendPause({
  agentId,
  onChanged,
}: {
  agentId: string;
  onChanged: () => void;
}) {
  const [limitCents, setLimitCents] = useState<number | null>(null);
  const [spentCents, setSpentCents] = useState<number | null>(null);
  const [workspaceHeld, setWorkspaceHeld] = useState<number | null>(null);
  const [raising, setRaising] = useState(false);
  const [raiseValue, setRaiseValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { orgRole } = useAuth();
  const isAdmin = orgRole === "org:admin";

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const caps = await getTrpc().spend.caps.query();
        const agent = caps.agents.find((item) => item.agentId === agentId);
        const ownCap = agent?.weeklyCapCents ?? null;
        if (active) {
          setLimitCents(agent?.weeklyCapCents ?? caps.workspaceCapCents);
        }
        const trpc = getTrpc();
        const { timezone } = await trpc.workspaces.timezone.query();
        const week = spendWeeks(new Date(), timezone).at(-1);
        if (!week) {
          return;
        }
        const rows = await trpc.spend.workspace.query({
          from: week.start,
          to: week.end,
        });
        const spend = weekSpend(rows, agentId, ownCap !== null);
        if (!active) {
          return;
        }
        setSpentCents(spend.spentCents);
        const workspaceCap = caps.workspaceCapCents;
        if (workspaceCap !== null && spend.totalCents >= workspaceCap) {
          setWorkspaceHeld(workspaceCap);
        }
      } catch {
        // Without the limit line the card still offers Resume and Raise.
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [agentId]);

  const resume = useCallback(
    async (weeklyCapCents?: number) => {
      setBusy(true);
      setError(null);
      try {
        await getTrpc().spend.resume.mutate(
          weeklyCapCents === undefined
            ? { agentId }
            : { agentId, weeklyCapCents }
        );
        onChanged();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy(false);
      }
    },
    [agentId, onChanged]
  );

  const onResume = useCallback(() => resume(), [resume]);

  const openRaise = useCallback(() => {
    setError(null);
    setRaiseValue(capInputValue(limitCents));
    setRaising(true);
  }, [limitCents]);

  const submitRaise = useCallback(() => {
    const parsed = parseCapInput(raiseValue);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    if (parsed.cents === null) {
      setError(PAUSE_NEEDS_LIMIT);
      return;
    }
    resume(parsed.cents);
  }, [raiseValue, resume]);

  return (
    <SpendPauseView
      atLimit={
        limitCents !== null && spentCents !== null && spentCents >= limitCents
      }
      busy={busy}
      error={error}
      isAdmin={isAdmin}
      limitText={pauseLimitText(limitCents, spentCents)}
      onRaiseChange={setRaiseValue}
      onRaiseOpen={openRaise}
      onRaiseSubmit={submitRaise}
      onResume={onResume}
      raiseValue={raiseValue}
      raising={raising}
      workspaceLimitText={
        workspaceHeld === null
          ? null
          : workspaceLimitMessage(workspaceHeld, isAdmin)
      }
    />
  );
}
