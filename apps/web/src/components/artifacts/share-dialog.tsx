import type {
  ArtifactDetail,
  ArtifactShare,
  ArtifactVersion,
} from "@repo/protocol/artifacts";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import { useIsMobile } from "#/hooks/use-mobile";
import { getTrpc } from "#/integrations/trpc/client";
import { CreateLinkForm } from "./create-link-form";
import { LinkList } from "./link-list";
import { errorMessage } from "./share-model";

export interface ShareDataFile {
  path: string;
  size: number;
}

export interface ShareDialogProps {
  artifactId: string;
  /** The version's files other than the entry file, when the parent has them. */
  dataFiles?: readonly ShareDataFile[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

type Audience = ArtifactDetail["audience"];
const AUDIENCES: readonly { label: string; value: Audience }[] = [
  { label: "Private", value: "private" },
  { label: "Workspace", value: "workspace" },
];

const formatKb = (bytes: number) =>
  `${Math.max(1, Math.round(bytes / 1024))} KB`;

interface LoadedData {
  detail: ArtifactDetail;
  shares: ArtifactShare[];
  versions: ArtifactVersion[];
}

function DataFiles({
  dataFiles,
  detail,
}: {
  dataFiles?: readonly ShareDataFile[];
  detail: ArtifactDetail;
}) {
  if (dataFiles === undefined) {
    const { fileCount, totalBytes } = detail.currentVersion;
    return (
      <p className="text-sm">
        {`${fileCount} ${fileCount === 1 ? "file" : "files"}, ${formatKb(totalBytes)} in this version`}
      </p>
    );
  }
  if (dataFiles.length === 0) {
    return <p className="text-muted-foreground text-sm">No data files.</p>;
  }
  return (
    <ul className="space-y-1 text-sm">
      {dataFiles.map((file) => (
        <li
          className="flex justify-between gap-3 [overflow-wrap:anywhere]"
          key={file.path}
        >
          <span>{file.path}</span>
          <span className="shrink-0 text-muted-foreground">
            {formatKb(file.size)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AudienceButton({
  current,
  onSelect,
  option,
}: {
  current: Audience;
  onSelect: (audience: Audience) => void;
  option: { label: string; value: Audience };
}) {
  const onClick = useCallback(() => onSelect(option.value), [onSelect, option]);
  const active = current === option.value;
  return (
    <Button
      aria-pressed={active}
      className="min-h-10 flex-1"
      onClick={onClick}
      type="button"
      variant={active ? "default" : "outline"}
    >
      {option.label}
    </Button>
  );
}

function ShareBody({
  artifactId,
  dataFiles,
}: {
  artifactId: string;
  dataFiles?: readonly ShareDataFile[];
}) {
  const [data, setData] = useState<LoadedData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const trpc = getTrpc();
      const [detail, shares, versions] = await Promise.all([
        trpc.artifacts.get.query({ artifactId }),
        trpc.artifacts.shares.query({ artifactId }),
        trpc.artifacts.versions.query({ artifactId }),
      ]);
      setData({ detail, shares, versions });
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [artifactId]);

  useEffect(() => {
    load();
  }, [load]);

  const changeAudience = useCallback(
    async (audience: Audience) => {
      try {
        await getTrpc().artifacts.setAudience.mutate({ artifactId, audience });
        toast.success("Audience updated");
        await load();
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [artifactId, load]
  );

  if (data === null) {
    return error === null ? (
      <p className="text-muted-foreground text-sm">Loading...</p>
    ) : (
      <p className="text-destructive text-sm" role="alert">
        {error}
      </p>
    );
  }

  const { detail, shares, versions } = data;
  const versionNumbers = new Map(versions.map((v) => [v.id, v.number]));
  const canCreate = detail.canManage && detail.linksEnabled;
  let note: string | null = null;
  if (!detail.linksEnabled) {
    note = "Link sharing is off for this workspace.";
  } else if (!detail.canManage) {
    note = "Only the owner or an admin can create links.";
  }

  return (
    <div className="space-y-5">
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <section className="space-y-2">
        <h3 className="font-medium text-sm">Who can open it</h3>
        {detail.canManage ? (
          <div className="flex gap-2">
            {AUDIENCES.map((option) => (
              <AudienceButton
                current={detail.audience}
                key={option.value}
                onSelect={changeAudience}
                option={option}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm">
            {AUDIENCES.find((o) => o.value === detail.audience)?.label}
          </p>
        )}
      </section>
      <section className="space-y-2">
        <h3 className="font-medium text-sm">Data files</h3>
        <DataFiles dataFiles={dataFiles} detail={detail} />
      </section>
      <section className="space-y-2">
        <h3 className="font-medium text-sm">Create link</h3>
        {canCreate ? (
          <CreateLinkForm
            artifactId={artifactId}
            currentVersionId={detail.currentVersion.id}
            currentVersionNumber={detail.currentVersion.number}
            onCreated={load}
          />
        ) : (
          <p className="text-muted-foreground text-sm">{note}</p>
        )}
      </section>
      <section className="space-y-2">
        <h3 className="font-medium text-sm">Links</h3>
        <LinkList
          onChanged={load}
          shares={shares}
          versionNumbers={versionNumbers}
        />
      </section>
    </div>
  );
}

export function ShareDialog({
  artifactId,
  dataFiles,
  onOpenChange,
  open,
}: ShareDialogProps) {
  const isMobile = useIsMobile();
  if (!open) {
    return null;
  }
  const body = <ShareBody artifactId={artifactId} dataFiles={dataFiles} />;
  if (isMobile) {
    return (
      <Sheet onOpenChange={onOpenChange} open>
        <SheetContent
          className="max-h-[90dvh] w-full overflow-y-auto"
          side="bottom"
        >
          <SheetHeader>
            <SheetTitle>Share</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-4">{body}</div>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Share</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
