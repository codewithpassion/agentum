import { formatDistanceToNow } from "date-fns";
import { useCallback } from "react";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { hostsOf, type SecretRecord } from "./secret-model.ts";

type SecretAction = (secret: SecretRecord) => void;

function SecretRow({
  onDelete,
  onEditRules,
  onReplace,
  secret,
}: {
  onDelete: SecretAction;
  onEditRules: SecretAction;
  onReplace: SecretAction;
  secret: SecretRecord;
}) {
  const replace = useCallback(() => onReplace(secret), [onReplace, secret]);
  const editRules = useCallback(
    () => onEditRules(secret),
    [onEditRules, secret]
  );
  const remove = useCallback(() => onDelete(secret), [onDelete, secret]);

  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{secret.name}</TableCell>
      <TableCell>
        <Badge variant={secret.mode === "proxy" ? "default" : "outline"}>
          {secret.mode}
        </Badge>
      </TableCell>
      <TableCell className="text-muted-foreground">{hostsOf(secret)}</TableCell>
      <TableCell className="text-muted-foreground">
        {formatDistanceToNow(new Date(secret.updatedAt), { addSuffix: true })}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={replace} size="sm" variant="outline">
            Replace value
          </Button>
          {secret.mode === "proxy" ? (
            <Button onClick={editRules} size="sm" variant="outline">
              Edit rules
            </Button>
          ) : null}
          <Button onClick={remove} size="sm" variant="outline">
            Delete
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function SecretsTable({
  onDelete,
  onEditRules,
  onReplace,
  secrets,
}: {
  onDelete: SecretAction;
  onEditRules: SecretAction;
  onReplace: SecretAction;
  secrets: SecretRecord[];
}) {
  if (secrets.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No secrets yet. Add one, then grant it on an agent's Secrets tab.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Mode</TableHead>
          <TableHead>Hosts</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {secrets.map((secret) => (
          <SecretRow
            key={secret.id}
            onDelete={onDelete}
            onEditRules={onEditRules}
            onReplace={onReplace}
            secret={secret}
          />
        ))}
      </TableBody>
    </Table>
  );
}
