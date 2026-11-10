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
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import type { AddDialogProps } from "./dialog-props.ts";
import { PublishGate } from "./publish-gate.tsx";

interface JoinResult {
  checkCode: string;
}

export function JoinDialog({
  agents,
  initialLink,
  onChanged,
  onClose,
}: AddDialogProps & { initialLink?: string }) {
  const [agentId, setAgentId] = useState("");
  const [link, setLink] = useState(initialLink ?? "");
  const [result, setResult] = useState<JoinResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A joined connection is a change, however the dialog closes after it.
  const close = useCallback(() => {
    if (result !== null) {
      onChanged();
    }
    onClose();
  }, [result, onChanged, onClose]);

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

  const handleLinkChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setLink(event.target.value);
    },
    []
  );

  const join = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const joined = await getTrpc().a2a.joinWithLink.mutate({ agentId, link });
      setResult({ checkCode: joined.checkCode });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }, [agentId, link]);

  const canJoin = !pending && agentId !== "" && link.trim() !== "";

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Join with a link</DialogTitle>
          <DialogDescription>
            Paste the invite link, then pick the agent that will connect.
          </DialogDescription>
        </DialogHeader>
        {result === null ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="join-link">Invite link</Label>
              <Input
                className="font-mono"
                id="join-link"
                onChange={handleLinkChange}
                value={link}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="join-agent">Agent</Label>
              <NativeSelect
                id="join-agent"
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
            {error !== null && (
              <p className="text-destructive text-sm">{error}</p>
            )}
            {agentId === "" ? null : (
              <PublishGate agentId={agentId}>
                <DialogFooter>
                  <Button disabled={!canJoin} onClick={join}>
                    Join
                  </Button>
                </DialogFooter>
              </PublishGate>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="font-mono text-3xl tracking-widest">
              {result.checkCode}
            </p>
            <p className="text-sm">
              Your connection waits for the other person to approve it. If the
              link came through anything you do not trust, compare this code
              with theirs. They see the same code.
            </p>
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
