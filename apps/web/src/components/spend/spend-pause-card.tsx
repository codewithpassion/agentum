import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useState,
} from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import { capInputValue, capLabel, parseCapInput } from "./spend-logic.ts";

export interface SpendPauseViewProps {
  busy: boolean;
  error: string | null;
  /** "The limit is $20 a week.", or null when it is not known. */
  limitText: string | null;
  onRaiseChange: (value: string) => void;
  onRaiseOpen: () => void;
  onRaiseSubmit: () => void;
  onResume: () => void;
  raiseValue: string;
  raising: boolean;
}

/** An agent paused at its weekly limit: resume it, or raise the limit and resume. */
export function SpendPauseView({
  busy,
  error,
  limitText,
  onRaiseChange,
  onRaiseOpen,
  onRaiseSubmit,
  onResume,
  raiseValue,
  raising,
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
          {limitText === null ? null : (
            <p className="text-muted-foreground">{limitText}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={onResume} size="sm" type="button">
              Resume
            </Button>
            <Button
              disabled={busy}
              onClick={onRaiseOpen}
              size="sm"
              type="button"
              variant="outline"
            >
              Raise the limit
            </Button>
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

/** Loads the agent's limit, then resumes the agent, optionally with a new limit. */
export function SpendPause({
  agentId,
  onChanged,
}: {
  agentId: string;
  onChanged: () => void;
}) {
  const [limitCents, setLimitCents] = useState<number | null>(null);
  const [raising, setRaising] = useState(false);
  const [raiseValue, setRaiseValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const caps = await getTrpc().spend.caps.query();
        const agent = caps.agents.find((item) => item.agentId === agentId);
        if (active) {
          setLimitCents(agent?.weeklyCapCents ?? caps.workspaceCapCents);
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
      busy={busy}
      error={error}
      limitText={
        limitCents === null
          ? null
          : `The limit is ${capLabel(limitCents)} a week.`
      }
      onRaiseChange={setRaiseValue}
      onRaiseOpen={openRaise}
      onRaiseSubmit={submitRaise}
      onResume={onResume}
      raiseValue={raiseValue}
      raising={raising}
    />
  );
}
