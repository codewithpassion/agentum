import { type ReactNode, useCallback } from "react";
import { Badge } from "#/components/ui/badge";
import { Switch } from "#/components/ui/switch";
import { TableCell, TableRow } from "#/components/ui/table";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { hostsOf } from "./grants.ts";

export type SecretRecord = RouterOutputs["secrets"]["list"][number];

export function SecretRow({
  disabled,
  granted,
  onToggle,
  secret,
}: {
  disabled: boolean;
  granted: boolean;
  onToggle: (secretId: string, granted: boolean) => void;
  secret: SecretRecord;
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
      <TableCell>
        <Switch
          aria-label={`Grant ${secret.name}`}
          checked={granted}
          disabled={disabled}
          onCheckedChange={handleChange}
        />
      </TableCell>
      <TableCell className="font-mono text-xs">{secret.name}</TableCell>
      <TableCell>
        <Badge variant="secondary">{secret.mode}</Badge>
      </TableCell>
      <TableCell className="font-mono text-muted-foreground text-xs">
        {hosts}
      </TableCell>
    </TableRow>
  );
}
