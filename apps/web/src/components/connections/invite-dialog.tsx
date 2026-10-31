import { type ChangeEvent, useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Label } from "#/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { getTrpc } from "#/integrations/trpc/client";
import type { AddDialogProps } from "./dialog-props.ts";
import { PublishGate } from "./publish-gate.tsx";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

export function InviteDialog({ agents, onChanged, onClose }: AddDialogProps) {
  const [agentId, setAgentId] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Any way out after a link was made counts as a change, so the page reloads.
  const close = useCallback(() => {
    if (link !== null) {
      onChanged();
    }
    onClose();
  }, [link, onChanged, onClose]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        close();
      }
    },
    [close]
  );

  const handleAgentChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setAgentId(event.target.value);
    },
    []
  );

  const createInvite = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const result = await getTrpc().a2a.createInvite.mutate({ agentId });
      setLink(result.link);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }, [agentId]);

  const copyLink = useCallback(async () => {
    setError(null);
    try {
      await navigator.clipboard.writeText(link ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [link]);

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Invite another Harbourmaster</DialogTitle>
          <DialogDescription>
            Pick the agent that will connect. Its public card is what the other
            side reads.
          </DialogDescription>
        </DialogHeader>
        {link === null ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-agent">Agent</Label>
              <NativeSelect
                id="invite-agent"
                onChange={handleAgentChange}
                value={agentId}
              >
                <NativeSelectOption value="">
                  Choose an agent
                </NativeSelectOption>
                {agents.map((agent) => (
                  <NativeSelectOption key={agent.id} value={agent.id}>
                    {agent.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            {agentId !== "" && (
              <PublishGate agentId={agentId}>
                <div>
                  <Button disabled={pending} onClick={createInvite}>
                    Create invite
                  </Button>
                </div>
              </PublishGate>
            )}
            {error !== null && (
              <p className="text-destructive text-sm">{error}</p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 font-mono text-foreground text-xs">
              {link}
            </pre>
            <p className="text-sm">
              Shown once. It works for 7 days and for one use. Send it only to
              the person you want to connect with.
            </p>
            <p className="text-muted-foreground text-sm">
              Their Harbourmaster shows a check code. Compare it with the one
              you see before you approve.
            </p>
            {error !== null && (
              <p className="text-destructive text-sm">{error}</p>
            )}
            <DialogFooter>
              <Button onClick={copyLink} variant="outline">
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
