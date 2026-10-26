import { useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { MailboxRecord } from "#/integrations/trpc/types";
import { CHIP_CLASS } from "./address-chip.tsx";
import { mailboxStatusLabel } from "./sheets/mail-logic.ts";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

const TONE_CLASS = {
  bad: "border-destructive text-destructive",
  default: "border-border",
  on: "border-primary text-primary",
  warn: "border-amber-300 bg-amber-100 text-amber-900",
} as const;

/** The agent's mail address, its status, and a retry when provisioning failed. */
export function MailStatus({
  agentId,
  mailbox,
  onOpenMail,
}: {
  agentId: string;
  mailbox: MailboxRecord;
  onOpenMail: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const status = mailboxStatusLabel(mailbox.status);

  const retry = useCallback(async () => {
    setPending(true);
    try {
      await getTrpc().mailbox.provision.mutate({ agentId });
      await router.invalidate();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }, [agentId, router]);

  return (
    <>
      <button
        className={`${CHIP_CLASS} border-primary bg-primary/10 font-mono text-primary`}
        onClick={onOpenMail}
        type="button"
      >
        {mailbox.address}
      </button>
      {mailbox.status === "active" ? null : (
        <span className={`${CHIP_CLASS} ${TONE_CLASS[status.tone]}`}>
          {status.label}
        </span>
      )}
      {mailbox.status === "failed" ? (
        <>
          {mailbox.lastError === null ? null : (
            <span
              className="max-w-xs truncate text-muted-foreground text-xs"
              title={mailbox.lastError}
            >
              {mailbox.lastError}
            </span>
          )}
          <Button
            disabled={pending}
            onClick={retry}
            size="sm"
            variant="outline"
          >
            Retry
          </Button>
        </>
      ) : null}
    </>
  );
}
