import { useAuth } from "@clerk/tanstack-react-start";
import { useCallback, useId, useState } from "react";
import { Label } from "#/components/ui/label";
import { Switch } from "#/components/ui/switch";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import { canToggleLinks } from "./share-model.ts";

export interface LinksSwitchProps {
  enabled: boolean;
  error: string | null;
  isAdmin: boolean;
  onChange: (enabled: boolean) => void;
  pending: boolean;
}

/** The workspace link-sharing switch. Members see it disabled. */
export function LinksSwitch({
  enabled,
  error,
  isAdmin,
  onChange,
  pending,
}: LinksSwitchProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Switch
          checked={enabled}
          className="after:-inset-y-3"
          disabled={!isAdmin || pending}
          id={id}
          onCheckedChange={onChange}
        />
        <Label className="min-h-10" htmlFor={id}>
          Allow link sharing
        </Label>
      </div>
      <p className="text-muted-foreground text-sm">
        When off, every share link in this workspace stops opening.
      </p>
      {isAdmin ? null : (
        <p className="text-muted-foreground text-sm" role="note">
          Only admins can change this.
        </p>
      )}
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Reads the person's role, saves the switch and puts it back if the save fails. */
export function LinksSwitchSection({
  initialEnabled,
}: {
  initialEnabled: boolean;
}) {
  const { orgRole } = useAuth();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = useCallback(async (next: boolean) => {
    setPending(true);
    setError(null);
    setEnabled(next);
    try {
      await getTrpc().artifacts.setLinksEnabled.mutate({ enabled: next });
    } catch (caught) {
      setEnabled(!next);
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }, []);

  return (
    <LinksSwitch
      enabled={enabled}
      error={error}
      isAdmin={canToggleLinks(orgRole)}
      onChange={change}
      pending={pending}
    />
  );
}
