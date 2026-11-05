import { Link } from "@tanstack/react-router";
import type { MailTone } from "#/components/agent/profile/sheets/mail-logic.ts";
import { Button } from "#/components/ui/button.tsx";
import type { MailThreadView } from "#/integrations/trpc/types";
import { mailMessageRows } from "./mail-logic.ts";

const CHIP_TONE: Record<MailTone, string> = {
  bad: "border-destructive text-destructive",
  default: "border-border text-muted-foreground",
  on: "border-primary bg-primary/10 text-primary",
  warn: "border-warning/40 bg-warning/15 text-warning",
};

/**
 * The mail card of the task view: the messages of the thread linked to the
 * task, each with its status. The button opens the thread in the agent's Mail
 * sheet. It renders nothing for a task without mail.
 */
export function MailSlot({
  agentId,
  error,
  thread,
}: {
  agentId: string;
  error: string | null;
  thread: MailThreadView | null;
}) {
  if (thread === null && error === null) {
    return null;
  }
  return (
    <section className="flex flex-col gap-3" data-testid="slot-mail">
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {thread === null ? null : (
        <>
          <p className="truncate font-medium text-sm" title={thread.subject}>
            {thread.subject === "" ? "(no subject)" : thread.subject}
          </p>
          <ul className="flex flex-col gap-1.5">
            {mailMessageRows(thread).map((row) => (
              <li
                className="flex items-center gap-2 text-xs"
                data-testid="mail-message"
                key={row.id}
              >
                <span className="shrink-0 font-medium">{row.label}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {row.who}
                </span>
                {row.chip === null ? null : (
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 ${CHIP_TONE[row.chip.tone]}`}
                  >
                    {row.chip.label}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <Button asChild className="self-start" size="sm" variant="outline">
            <Link
              params={{ agentId }}
              search={{ mail: thread.id }}
              to="/agents/$agentId"
            >
              Open the mail thread
            </Link>
          </Button>
        </>
      )}
    </section>
  );
}
