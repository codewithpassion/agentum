import { type ReactNode, useCallback } from "react";
import { ResponsiveCell } from "#/components/responsive-table/responsive-table";
import { Badge } from "#/components/ui/badge";
import { Switch } from "#/components/ui/switch";
import { TableRow } from "#/components/ui/table";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { hostsOf } from "./grants.ts";
import type { SecretStatus } from "./status.ts";

export type SecretRecord = RouterOutputs["secrets"]["list"][number];

export function SecretRow({
  disabled,
  granted,
  onToggle,
  secret,
  status,
}: {
  disabled: boolean;
  granted: boolean;
  onToggle: (secretId: string, granted: boolean) => void;
  secret: SecretRecord;
  status: SecretStatus | null | undefined;
}) {
  const secretId = secret.id;
  const handleChange = useCallback(
    (checked: boolean) => onToggle(secretId, checked),
    [onToggle, secretId]
  );

  let hosts: ReactNode = null;
  if (secret.mode === "proxy") {
    hosts = hostsOf(secret.rules).join(", ");
  }

  return (
    <TableRow>
      <ResponsiveCell label="Granted">
        <Switch
          aria-label={`Grant ${secret.name}`}
          checked={granted}
          disabled={disabled}
          onCheckedChange={handleChange}
        />
      </ResponsiveCell>
      <ResponsiveCell className="font-mono text-xs" label="Name">
        {secret.name}
      </ResponsiveCell>
      <ResponsiveCell label="Mode">
        <Badge variant="secondary">{secret.mode}</Badge>
      </ResponsiveCell>
      <ResponsiveCell
        className="font-mono text-muted-foreground text-xs"
        label="Hosts"
      >
        {hosts}
      </ResponsiveCell>
      <ResponsiveCell
        className={`text-xs ${status?.works === false ? "text-destructive" : "text-muted-foreground"}`}
        label="Status"
      >
        {status?.text}
      </ResponsiveCell>
    </TableRow>
  );
}
