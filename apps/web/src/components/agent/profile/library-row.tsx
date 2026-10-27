import { useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "#/components/library/library-logic.ts";
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";
import type { AgentProfileView, AgentRecord } from "#/integrations/trpc/types";
import {
  type AccessMode,
  modeLabel,
  otherMode,
  splitFolders,
} from "./library-access.ts";
import { LibraryFolderPicker } from "./library-folder-picker.tsx";
import { folderLabel, LIBRARY_NOTE, WIKI_LABEL } from "./profile-logic.ts";

/** A path that breaks after its slashes, never inside a name. */
function PathText({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <span className="font-mono text-xs max-md:min-w-0 max-md:break-words">
      {parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: path segments repeat and never reorder
        <span key={index}>
          {index > 0 ? (
            <>
              /<wbr className="md:hidden" />
            </>
          ) : null}
          {part}
        </span>
      ))}
    </span>
  );
}

type Folder = AgentProfileView["library"]["folders"][number];

function FixedLine({ label, path }: { label: string; path: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <PathText path={path} />
      <span className="rounded-full border px-2 py-0.5 text-muted-foreground text-xs">
        {label}
      </span>
    </div>
  );
}

function GrantLine({
  disabled,
  folder,
  onRemove,
  onSet,
}: {
  disabled: boolean;
  folder: Folder;
  onRemove: (path: string) => void;
  onSet: (path: string, mode: AccessMode) => void;
}) {
  const flip = useCallback(
    () => onSet(folder.path, otherMode(folder.access)),
    [folder.access, folder.path, onSet]
  );
  const remove = useCallback(
    () => onRemove(folder.path),
    [folder.path, onRemove]
  );
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <PathText path={folder.path} />
      <span className="flex items-center gap-2">
        <Button
          aria-label={`${folder.path}: ${folderLabel(folder)}. Switch to ${modeLabel(otherMode(folder.access)).toLowerCase()}`}
          disabled={disabled}
          onClick={flip}
          size="sm"
          variant="outline"
        >
          {modeLabel(folder.access)}
        </Button>
        <Button disabled={disabled} onClick={remove} size="sm" variant="ghost">
          Remove
        </Button>
      </span>
    </div>
  );
}

export function LibraryRow({
  agent,
  folders,
}: {
  agent: AgentRecord;
  folders: AgentProfileView["library"]["folders"];
}) {
  const router = useRouter();
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const { grants, home, wiki } = splitFolders(folders);

  const run = useCallback(
    async (change: () => Promise<unknown>) => {
      setSaving(true);
      try {
        await change();
        await router.invalidate();
        toast.success("Saved");
      } catch (cause) {
        toast.error(errorMessage(cause));
      } finally {
        setSaving(false);
      }
    },
    [router]
  );

  const setMode = useCallback(
    (path: string, mode: AccessMode) =>
      run(() =>
        getTrpc().library.access.set.mutate({ agentId: agent.id, mode, path })
      ),
    [agent.id, run]
  );

  const removeGrant = useCallback(
    (path: string) =>
      run(() =>
        getTrpc().library.access.remove.mutate({ agentId: agent.id, path })
      ),
    [agent.id, run]
  );

  const addFolder = useCallback(
    async (path: string) => {
      setPicking(false);
      await setMode(path, "read");
    },
    [setMode]
  );

  const openPicker = useCallback(() => setPicking(true), []);

  return (
    <div className="flex flex-col gap-1.5">
      {home ? <FixedLine label={folderLabel(home)} path={home.path} /> : null}
      {wiki ? <FixedLine label={WIKI_LABEL} path={wiki.path} /> : null}
      {grants.map((folder) => (
        <GrantLine
          disabled={saving}
          folder={folder}
          key={folder.path}
          onRemove={removeGrant}
          onSet={setMode}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="rounded-full border-dashed"
          disabled={saving}
          onClick={openPicker}
          size="sm"
          variant="outline"
        >
          + Add folder
        </Button>
        <span className="text-muted-foreground text-xs">{LIBRARY_NOTE}</span>
      </div>
      <LibraryFolderPicker
        onChoose={addFolder}
        onOpenChange={setPicking}
        open={picking}
      />
    </div>
  );
}
