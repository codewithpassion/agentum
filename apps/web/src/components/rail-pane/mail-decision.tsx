import type { RailCard } from "@repo/db/shared";
import { type ChangeEvent, useCallback, useId, useState } from "react";
import type { AnswerPayload } from "#/components/requests/request-card-logic.ts";
import { errorMessage } from "#/components/triggers/format.ts";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import {
  alwaysSendAnswer,
  notThisTimeAnswer,
  sendReplyAnswer,
} from "./answer.ts";

/** A held mail reply: what they wrote, the reply in plain type, and the three ways to answer. */
export function MailDecision({
  card,
  cc,
  expiry,
  offerAlways = true,
  onAnswer,
  waitingOn,
}: {
  card: RailCard;
  /** Cc addresses of the held mail. They get the reply too. */
  cc: readonly string[];
  /** "expires in 42 min", or null while plenty of time is left. */
  expiry: string | null;
  /** Whether to offer "Always send to this address". Defaults to true. */
  offerAlways?: boolean;
  onAnswer: (cardId: string, payload: AnswerPayload) => Promise<void>;
  /** Who it waits on, or null for anyone. */
  waitingOn: string | null;
}) {
  const { mail } = card;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [note, setNote] = useState("");
  const noteId = useId();

  const submit = useCallback(
    async (payload: AnswerPayload) => {
      setPending(true);
      setError(null);
      try {
        await onAnswer(card.id, payload);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setPending(false);
      }
    },
    [card.id, onAnswer]
  );
  const send = useCallback(() => submit(sendReplyAnswer()), [submit]);
  const always = useCallback(() => submit(alwaysSendAnswer()), [submit]);
  const deny = useCallback(
    () => submit(notThisTimeAnswer(note)),
    [note, submit]
  );
  const openNote = useCallback(() => setChanging(true), []);
  const handleNote = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setNote(event.target.value),
    []
  );

  if (mail === null) {
    return null;
  }
  return (
    <div className="flex flex-col gap-4" data-testid="mail-decision">
      <p className="text-muted-foreground text-sm">
        Goes to {mail.to.join(", ")}
        {cc.length === 0 ? null : `, Cc ${cc.join(", ")}`}
      </p>
      {mail.theyWrote === null ? null : (
        <blockquote className="border-border border-l-2 pl-3.5 text-muted-foreground">
          <small className="block text-muted-foreground/70 text-xs">
            They wrote
          </small>
          {mail.theyWrote}
        </blockquote>
      )}
      <div
        className="whitespace-pre-wrap rounded-lg border border-border bg-card p-4 text-card-foreground"
        data-testid="mail-reply"
      >
        {mail.body}
      </div>
      {changing ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor={noteId}>Tell it what to change</Label>
          <Input
            disabled={pending}
            id={noteId}
            onChange={handleNote}
            value={note}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={pending} onClick={send} type="button">
          Send reply
        </Button>
        <Button
          disabled={pending}
          onClick={deny}
          type="button"
          variant="outline"
        >
          Not this time
        </Button>
        {changing ? null : (
          <Button
            disabled={pending}
            onClick={openNote}
            type="button"
            variant="ghost"
          >
            Tell it what to change
          </Button>
        )}
        {offerAlways ? (
          <Button
            className="text-muted-foreground"
            disabled={pending}
            onClick={always}
            type="button"
            variant="link"
          >
            Always send to this address
          </Button>
        ) : null}
        <span className="ml-auto text-muted-foreground text-sm">
          {waitingOn === null ? null : `Waiting on ${waitingOn}`}
          {waitingOn !== null && expiry !== null ? " · " : null}
          {expiry}
        </span>
      </div>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
