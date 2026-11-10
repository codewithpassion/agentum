import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";
import type { MailThreadView } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";
import {
  approvalNote,
  directionLabel,
  type MailTone,
  messageStatusChip,
  parseAddresses,
} from "./mail-logic.ts";

const CHIP_TONE: Record<MailTone, string> = {
  bad: "border-destructive text-destructive",
  default: "border-border text-muted-foreground",
  on: "border-primary bg-primary/10 text-primary",
  warn: "border-warning/40 bg-warning/15 text-warning",
};

interface MailThreadPanelProps {
  onBack: () => void;
  threadId: string;
}

export function MailThreadPanel({ onBack, threadId }: MailThreadPanelProps) {
  const [thread, setThread] = useState<MailThreadView | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let active = true;
    getTrpc()
      .thread.query({ id: threadId })
      .then((view) => {
        if (active) {
          setThread(view);
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
  }, [threadId]);

  let body: ReactNode;
  if (thread === undefined) {
    body =
      error === undefined ? (
        <p className="text-muted-foreground text-sm">Loading...</p>
      ) : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      );
  } else {
    body = (
      <>
        <h3 className="font-medium text-base">
          {thread.subject === "" ? "(no subject)" : thread.subject}
        </h3>
        <ol className="flex flex-col gap-3">
          {thread.messages.map((message) => {
            const chip = messageStatusChip(message.status);
            const note = approvalNote(message.status);
            const cc = parseAddresses(message.ccAddresses);
            const attachments = message.body?.attachments ?? [];
            return (
              <li
                className="flex flex-col gap-2 rounded-md border p-3"
                key={message.id}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium">
                    {directionLabel(message.direction)}
                  </span>
                  {chip !== null && (
                    <span
                      className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs ${CHIP_TONE[chip.tone]}`}
                    >
                      {chip.label}
                    </span>
                  )}
                  <span className="text-muted-foreground">
                    {new Date(message.createdAt).toLocaleString()}
                  </span>
                </div>
                {note !== null && (
                  <p className="text-muted-foreground text-xs">{note}</p>
                )}
                <p className="text-sm max-md:[overflow-wrap:anywhere]">
                  From: {parseAddresses(message.fromAddress).join(", ")}
                </p>
                <p className="text-sm max-md:[overflow-wrap:anywhere]">
                  To: {parseAddresses(message.toAddresses).join(", ")}
                </p>
                {cc.length > 0 && (
                  <p className="text-sm max-md:[overflow-wrap:anywhere]">
                    Cc: {cc.join(", ")}
                  </p>
                )}
                <div className="whitespace-pre-wrap text-sm max-md:[overflow-wrap:anywhere]">
                  {message.body?.text ?? message.snippet}
                </div>
                {attachments.length > 0 && (
                  <p className="text-muted-foreground text-xs">
                    Attachments: {attachments.map((a) => a.filename).join(", ")}
                  </p>
                )}
                {message.runId !== null && (
                  <Link
                    className="text-primary text-sm underline"
                    params={{ runId: message.runId }}
                    to="/tasks/$runId"
                  >
                    Open task
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </>
    );
  }

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <div>
        <Button onClick={onBack} size="sm" type="button" variant="ghost">
          Back
        </Button>
      </div>
      {body}
    </section>
  );
}
