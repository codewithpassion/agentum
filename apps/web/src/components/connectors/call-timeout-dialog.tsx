import { CONNECTOR_CALL_TIMEOUT_SECONDS } from "@repo/db/shared";
import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
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
import { getTrpc } from "#/integrations/trpc/client";

const { min, max } = CONNECTOR_CALL_TIMEOUT_SECONDS;
const WHOLE_NUMBER = /^\d+$/;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

function parseSeconds(raw: string): number | null {
  const trimmed = raw.trim();
  if (!WHOLE_NUMBER.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

export function CallTimeoutDialog({
  connector,
  onClose,
  onSaved,
}: {
  connector: { id: string; name: string; callTimeoutSeconds: number };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(String(connector.callTimeoutSeconds));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seconds = parseSeconds(value);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );

  const handleValueChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setValue(event.target.value);
    },
    []
  );

  const save = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (seconds === null) {
        return;
      }
      setPending(true);
      setError(null);
      try {
        await getTrpc().connectors.setCallTimeout.mutate({
          connectorId: connector.id,
          seconds,
        });
        onSaved();
      } catch (caught) {
        setError(errorMessage(caught));
        setPending(false);
      }
    },
    [connector.id, onSaved, seconds]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent>
        <form onSubmit={save}>
          <DialogHeader>
            <DialogTitle>Call time limit for {connector.name}</DialogTitle>
            <DialogDescription>
              A tool call to this connector is stopped after this many seconds
              and the model gets an error. Between {min} and {max}.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="call-timeout-seconds">Seconds</Label>
              <Input
                id="call-timeout-seconds"
                max={max}
                min={min}
                onChange={handleValueChange}
                step={1}
                type="number"
                value={value}
              />
            </div>
            {error !== null && (
              <p className="text-destructive text-sm">{error}</p>
            )}
            <DialogFooter>
              <Button disabled={pending || seconds === null} type="submit">
                Save
              </Button>
            </DialogFooter>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
