import { useRouter } from "@tanstack/react-router";
import { type ChangeEvent, useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Switch } from "#/components/ui/switch";
import { getTrpc } from "#/integrations/trpc/client";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

/**
 * The pairing block of the Connections card: whether outside clients without a
 * key may ask for a pairing code, and a form to type a code in. There is no
 * approve button and no list of requests on purpose. Only a code the owner
 * heard from gets in.
 */
export function PairingSection({
  agentId,
  pairingOpen,
}: {
  agentId: string;
  pairingOpen: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(pairingOpen);
  const [switchPending, setSwitchPending] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [pairPending, setPairPending] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);

  const handleOpenChange = useCallback(
    async (next: boolean) => {
      setSwitchPending(true);
      setSwitchError(null);
      try {
        const card = await getTrpc().a2a.setPairingOpen.mutate({
          agentId,
          open: next,
        });
        setOpen(card.pairingOpen);
      } catch (caught) {
        setSwitchError(errorMessage(caught));
      } finally {
        setSwitchPending(false);
      }
    },
    [agentId]
  );

  const handleCodeChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setCode(event.target.value);
    },
    []
  );

  const handleLabelChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setLabel(event.target.value);
    },
    []
  );

  const pair = useCallback(async () => {
    setPairPending(true);
    setPairError(null);
    setPaired(false);
    try {
      await getTrpc().a2a.approvePairingCode.mutate({ agentId, code, label });
      setCode("");
      setLabel("");
      setPaired(true);
      await router.invalidate();
    } catch (caught) {
      setPairError(errorMessage(caught));
    } finally {
      setPairPending(false);
    }
  }, [agentId, code, label, router]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="pairing-switch">Accept pairing requests</Label>
          <Switch
            checked={open}
            disabled={switchPending}
            id="pairing-switch"
            onCheckedChange={handleOpenChange}
          />
        </div>
        <p className="text-muted-foreground text-xs">
          When this is on, an outside client with no key can ask this agent for
          a pairing code. Nothing it sends is delivered or stored. It gets a
          code, and it only gets in if you type that code in below. Turn it off
          to drop any requests still waiting.
        </p>
        {switchError === null ? null : (
          <p className="text-destructive text-sm">{switchError}</p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="font-medium text-sm">Enter a pairing code</h3>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pairing-code">Pairing code</Label>
          <Input
            autoComplete="off"
            className="font-mono uppercase"
            id="pairing-code"
            maxLength={40}
            onChange={handleCodeChange}
            value={code}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pairing-label">Label</Label>
          <Input
            id="pairing-label"
            maxLength={80}
            onChange={handleLabelChange}
            placeholder="Hermes on Sam's box"
            value={label}
          />
        </div>
        <div>
          <Button
            disabled={pairPending || code.trim() === "" || label.trim() === ""}
            onClick={pair}
          >
            Pair
          </Button>
        </div>
        {pairError === null ? null : (
          <p className="text-destructive text-sm">{pairError}</p>
        )}
        {paired ? (
          <p className="text-sm">
            Paired. It can send messages now, and each one waits for your
            approval.
          </p>
        ) : null}
      </div>
    </div>
  );
}
