import { type ReactNode, useCallback, useEffect, useState } from "react";
import { getTrpc } from "#/integrations/trpc/client";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";
import { cn } from "#/lib/utils.ts";
import {
  directionLabel,
  type MailTone,
  messageStatusChip,
} from "./mail-logic.ts";

type MailThreadRow = RouterOutputs["threads"][number];

const TONE_CLASS: Record<MailTone, string> = {
  bad: "border-destructive text-destructive",
  default: "border-border",
  on: "border-primary bg-primary/10 text-primary",
  warn: "border-warning/40 bg-warning/15 text-warning",
};

const loadRows = (agentId: string): Promise<MailThreadRow[]> =>
  getTrpc().threads.query({ agentId });

function Chip({ label, tone }: { label: string; tone: MailTone }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full border px-2.5 py-0.5 text-xs",
        TONE_CLASS[tone]
      )}
    >
      {label}
    </span>
  );
}

function MailListItem({
  thread,
  onOpen,
}: {
  onOpen: (threadId: string) => void;
  thread: MailThreadRow;
}) {
  const open = useCallback(() => onOpen(thread.id), [onOpen, thread.id]);
  const status =
    thread.lastStatus === null ? null : messageStatusChip(thread.lastStatus);
  return (
    <li>
      <button
        className="flex w-full flex-col gap-1.5 border-border border-b py-2.5 text-left hover:bg-muted/50"
        onClick={open}
        type="button"
      >
        <span className="truncate font-semibold text-sm">
          {thread.subject === "" ? "(no subject)" : thread.subject}
        </span>
        <span className="text-muted-foreground text-xs">
          {new Date(thread.lastMessageAt).toLocaleString()}
          {` · ${thread.messageCount} messages`}
        </span>
        {thread.lastDirection === null ? null : (
          <span className="flex flex-wrap gap-1.5">
            <Chip label={directionLabel(thread.lastDirection)} tone="default" />
            {status === null ? null : (
              <Chip label={status.label} tone={status.tone} />
            )}
          </span>
        )}
      </button>
    </li>
  );
}

/** The mail threads of one agent, newest first. Opening a row calls `onOpen` with its id. */
export function MailList({
  agentId,
  onOpen,
}: {
  agentId: string;
  onOpen: (threadId: string) => void;
}) {
  const [rows, setRows] = useState<MailThreadRow[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let active = true;
    loadRows(agentId)
      .then((loaded) => {
        if (active) {
          setRows(loaded);
          setError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(errorMessage(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [agentId]);

  let body: ReactNode;
  if (error !== undefined) {
    body = (
      <p className="text-destructive text-sm" role="alert">
        {error}
      </p>
    );
  } else if (rows === undefined) {
    body = <p className="text-muted-foreground text-sm">Loading...</p>;
  } else if (rows.length === 0) {
    body = <p className="text-muted-foreground text-sm">No mail yet.</p>;
  } else {
    body = (
      <ul className="flex flex-col">
        {rows.map((thread) => (
          <MailListItem key={thread.id} onOpen={onOpen} thread={thread} />
        ))}
      </ul>
    );
  }

  return <section className="flex max-w-3xl flex-col gap-4">{body}</section>;
}
