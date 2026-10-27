import type { ArtifactShare } from "@repo/protocol/artifacts";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ConfirmButton } from "#/components/confirm-action/confirm-button";
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
import { getTrpc } from "#/integrations/trpc/client";
import {
  errorMessage,
  formatTimestamp,
  revokeConfirmCopy,
  SHARE_STATUS_LABELS,
  shareVersionLabel,
} from "./share-model";

export interface LinkListProps {
  onChanged: () => void;
  shares: readonly ArtifactShare[];
  versionNumbers: ReadonlyMap<string, number>;
}

const byNewest = (a: ArtifactShare, b: ArtifactShare) =>
  b.createdAt.localeCompare(a.createdAt);

const copyLink = async (url: string) => {
  try {
    await navigator.clipboard.writeText(url);
    toast.success("Link copied");
  } catch {
    toast.error("Could not copy the link.");
  }
};

function LinkRow({
  onRevoke,
  share,
  versionNumbers,
}: {
  onRevoke: (shareId: string) => void;
  share: ArtifactShare;
  versionNumbers: ReadonlyMap<string, number>;
}) {
  const live = share.status === "active";
  const onCopy = useCallback(() => copyLink(share.url), [share.url]);
  const onConfirm = useCallback(() => onRevoke(share.id), [onRevoke, share.id]);
  return (
    <TableRow className={live ? undefined : "text-muted-foreground"}>
      <ResponsiveCell label="Created by">{share.createdBy}</ResponsiveCell>
      <ResponsiveCell label="Created">
        {formatTimestamp(share.createdAt)}
      </ResponsiveCell>
      <ResponsiveCell label="Expires">
        {formatTimestamp(share.expiresAt)}
      </ResponsiveCell>
      <ResponsiveCell label="Opens">{share.openCount}</ResponsiveCell>
      <ResponsiveCell label="Last opened">
        {share.lastOpenedAt === null
          ? "Never"
          : formatTimestamp(share.lastOpenedAt)}
      </ResponsiveCell>
      <ResponsiveCell label="Version">
        {shareVersionLabel(share, versionNumbers)}
      </ResponsiveCell>
      <ResponsiveCell label="Status">
        <Badge variant={live ? "default" : "secondary"}>
          {SHARE_STATUS_LABELS[share.status]}
        </Badge>
      </ResponsiveCell>
      <ResponsiveActions>
        {live ? (
          <>
            <Button
              className="min-h-10"
              onClick={onCopy}
              size="sm"
              type="button"
              variant="outline"
            >
              Copy
            </Button>
            <ConfirmButton
              {...revokeConfirmCopy(share)}
              className="min-h-10"
              onConfirm={onConfirm}
              size="sm"
              type="button"
              variant="destructive"
            >
              Revoke
            </ConfirmButton>
          </>
        ) : null}
      </ResponsiveActions>
    </TableRow>
  );
}

export function LinkList({ onChanged, shares, versionNumbers }: LinkListProps) {
  const [error, setError] = useState<string | null>(null);

  const revoke = useCallback(
    async (shareId: string) => {
      setError(null);
      try {
        await getTrpc().artifacts.revokeShare.mutate({ shareId });
        toast.success("Link revoked");
        onChanged();
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [onChanged]
  );

  if (shares.length === 0) {
    return <p className="text-muted-foreground text-sm">No links yet.</p>;
  }

  return (
    <div className="space-y-2">
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <ResponsiveTable>
        <TableHeader>
          <TableRow>
            <TableHead>Created by</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead>Opens</TableHead>
            <TableHead>Last opened</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...shares].sort(byNewest).map((share) => (
            <LinkRow
              key={share.id}
              onRevoke={revoke}
              share={share}
              versionNumbers={versionNumbers}
            />
          ))}
        </TableBody>
      </ResponsiveTable>
    </div>
  );
}
