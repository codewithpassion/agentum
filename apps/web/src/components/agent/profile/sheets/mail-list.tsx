import { type ReactNode, useCallback, useEffect, useState } from "react";
import { getTrpc } from "#/integrations/trpc/client";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { cn } from "#/lib/utils.ts";
import {
  directionLabel,
  latestMessageState,
  type MailTone,
  messageStatusChip,
} from "./mail-logic.ts";

/** How many threads get their messages fetched for the state chips. */
const DETAIL_LIMIT = 30;

type MailThreadRow = RouterOutputs["threads"][number];
type ThreadDetail = RouterOutputs["thread"];
type LatestState = NonNullable<ReturnType<typeof latestMessageState>>;

interface MailListRow {
  count: number | undefined;
  state: LatestState | null;
  thread: MailThreadRow;
}

const TONE_CLASS: Record<MailTone, string> = {
  bad: "border-destructive text-destructive",
  default: "border-border",
  on: "border-primary bg-primary/10 text-primary",
  warn: "border-amber-400 bg-amber-100 text-amber-900",
};

const rowFor = (
  thread: MailThreadRow,
  detail: PromiseSettledResult<ThreadDetail> | undefined
): MailListRow => {
  if (detail?.status !== "fulfilled") {
    return { count: undefined, state: null, thread };
  }
  const { messages } = detail.value;
  return {
    count: messages.length,
    state: latestMessageState(messages),
    thread,
  };
};

const loadRows = async (agentId: string): Promise<MailListRow[]> => {
  const threads = await getTrpc().threads.query({ agentId });
  const details = await Promise.allSettled(
    threads
      .slice(0, DETAIL_LIMIT)
      .map((thread) => getTrpc().thread.query({ id: thread.id }))
  );
  return threads.map((thread, index) => rowFor(thread, details[index]));
};

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
  row,
  onOpen,
}: {
  onOpen: (threadId: string) => void;
  row: MailListRow;
}) {
  const { thread } = row;
  const open = useCallback(() => onOpen(thread.id), [onOpen, thread.id]);
  const status =
    row.state === null ? null : messageStatusChip(row.state.status);
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
          {row.count === undefined ? null : ` · ${row.count} messages`}
        </span>
        {row.state === null ? null : (
          <span className="flex flex-wrap gap-1.5">
            <Chip label={directionLabel(row.state.direction)} tone="default" />
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
  const [rows, setRows] = useState<MailListRow[] | undefined>();
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
          setError(cause instanceof Error ? cause.message : String(cause));
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
        {rows.map((row) => (
          <MailListItem key={row.thread.id} onOpen={onOpen} row={row} />
        ))}
      </ul>
    );
  }

  return <section className="flex max-w-3xl flex-col gap-4">{body}</section>;
}
