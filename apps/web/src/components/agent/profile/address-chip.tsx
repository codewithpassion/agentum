import { useRouter } from "@tanstack/react-router";
import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import { addressText } from "./profile-logic.ts";

export const CHIP_CLASS =
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs";

/** The agent's address, or a way to reserve one. */
export function AddressChip({
  agentId,
  emailLocal,
  suggestion,
}: {
  agentId: string;
  emailLocal: string | null;
  /** The address to start from, usually the agent's slug. */
  suggestion: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState(suggestion);
  const [hint, setHint] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  const open = useCallback(() => setEditing(true), []);
  const cancel = useCallback(() => {
    setEditing(false);
    setHint(undefined);
  }, []);

  const change = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setLocal(event.target.value.toLowerCase());
    setHint(undefined);
  }, []);

  const check = useCallback(async () => {
    try {
      const { available } = await getTrpc().agents.checkAddress.query({
        local,
      });
      setHint(available ? "Available" : "That address is taken");
      return available;
    } catch (error) {
      setHint(errorMessage(error));
      return false;
    }
  }, [local]);

  const reserve = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setPending(true);
      try {
        if (!(await check())) {
          return;
        }
        await getTrpc().agents.reserveAddress.mutate({ agentId, local });
        await router.invalidate();
        setEditing(false);
        toast.success("Address reserved");
      } catch (error) {
        setHint(errorMessage(error));
      } finally {
        setPending(false);
      }
    },
    [agentId, check, local, router]
  );

  if (emailLocal !== null) {
    return (
      <span
        className={`${CHIP_CLASS} border-primary bg-primary/10 font-mono text-primary`}
      >
        {addressText(emailLocal, "")}
      </span>
    );
  }
  if (!editing) {
    return (
      <button
        className={`${CHIP_CLASS} border-dashed text-muted-foreground`}
        onClick={open}
        type="button"
      >
        Reserve an address
      </button>
    );
  }
  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={reserve}>
      <Input
        aria-label="Address"
        autoFocus
        className="h-8 w-48 font-mono"
        onBlur={check}
        onChange={change}
        value={local}
      />
      <Button disabled={pending || local === ""} size="sm" type="submit">
        Reserve
      </Button>
      <Button onClick={cancel} size="sm" type="button" variant="ghost">
        Cancel
      </Button>
      {hint === undefined ? null : (
        <span className="text-muted-foreground text-xs">{hint}</span>
      )}
    </form>
  );
}
