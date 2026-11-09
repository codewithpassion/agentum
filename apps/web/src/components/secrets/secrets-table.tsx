import { formatDistanceToNow } from "date-fns";
import { useCallback } from "react";
import {
  ResponsiveActions,
  ResponsiveCell,
  ResponsiveTable,
} from "#/components/responsive-table/responsive-table";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { hostsOf, type SecretRecord } from "./secret-model.ts";

type SecretAction = (secret: SecretRecord) => void;

function SecretRow({
  onChangeMode,
  onDelete,
  onEditHosts,
  onEditRules,
  onReplace,
  secret,
}: {
  onChangeMode: SecretAction | undefined;
  onDelete: SecretAction;
  onEditHosts: SecretAction;
  onEditRules: SecretAction;
  onReplace: SecretAction;
  secret: SecretRecord;
}) {
  const replace = useCallback(() => onReplace(secret), [onReplace, secret]);
  const editRules = useCallback(
    () => onEditRules(secret),
    [onEditRules, secret]
  );
  const editHosts = useCallback(
    () => onEditHosts(secret),
    [onEditHosts, secret]
  );
  const changeMode = useCallback(
    () => onChangeMode?.(secret),
    [onChangeMode, secret]
  );
  const remove = useCallback(() => onDelete(secret), [onDelete, secret]);

  return (
    <TableRow>
      <ResponsiveCell className="font-mono text-xs" label="Name">
        {secret.name}
      </ResponsiveCell>
      <ResponsiveCell label="Mode">
        <Badge variant={secret.mode === "proxy" ? "default" : "outline"}>
          {secret.mode}
        </Badge>
      </ResponsiveCell>
      <ResponsiveCell className="text-muted-foreground" label="Hosts">
        {hostsOf(secret)}
      </ResponsiveCell>
      <ResponsiveCell className="text-muted-foreground" label="Updated">
        {formatDistanceToNow(new Date(secret.updatedAt), { addSuffix: true })}
      </ResponsiveCell>
      <ResponsiveActions>
        <div className="flex flex-wrap justify-end gap-2 max-md:justify-start">
          <Button onClick={replace} size="sm" variant="outline">
            Replace value
          </Button>
          {secret.mode === "proxy" ? (
            <Button onClick={editRules} size="sm" variant="outline">
              Edit rules
            </Button>
          ) : (
            <Button onClick={editHosts} size="sm" variant="outline">
              Edit hosts
            </Button>
          )}
          {onChangeMode === undefined ? null : (
            <Button onClick={changeMode} size="sm" variant="outline">
              Change mode
            </Button>
          )}
          <Button onClick={remove} size="sm" variant="outline">
            Delete
          </Button>
        </div>
      </ResponsiveActions>
    </TableRow>
  );
}

export function SecretsTable({
  onChangeMode,
  onDelete,
  onEditHosts,
  onEditRules,
  onReplace,
  secrets,
}: {
  /** Left out for a member who is not an admin: only an admin changes a secret's mode. */
  onChangeMode?: SecretAction;
  onDelete: SecretAction;
  onEditHosts: SecretAction;
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
    <ResponsiveTable>
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
            onChangeMode={onChangeMode}
            onDelete={onDelete}
            onEditHosts={onEditHosts}
            onEditRules={onEditRules}
            onReplace={onReplace}
            secret={secret}
          />
        ))}
      </TableBody>
    </ResponsiveTable>
  );
}
