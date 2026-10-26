import { useRouter } from "@tanstack/react-router";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { getTrpc } from "#/integrations/trpc/client";
import type { AgentProfileView, AgentRecord } from "#/integrations/trpc/types";
import { nextLibraryPaths, withoutPath } from "./library-paths.ts";
import { folderLabel, LIBRARY_NOTE } from "./profile-logic.ts";

type Folder = AgentProfileView["library"]["folders"][number];

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

function FolderLine({
  disabled,
  folder,
  onRemove,
}: {
  disabled: boolean;
  folder: Folder;
  onRemove: (path: string) => void;
}) {
  const remove = useCallback(
    () => onRemove(folder.path),
    [folder.path, onRemove]
  );
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="font-mono text-xs">{folder.path}</span>
      <span className="flex items-center gap-2">
        <span className="rounded-full border px-2 py-0.5 text-muted-foreground text-xs">
          {folderLabel(folder)}
        </span>
        {folder.home ? null : (
          <Button
            disabled={disabled}
            onClick={remove}
            size="sm"
            variant="ghost"
          >
            Remove
          </Button>
        )}
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
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const extraPaths = useMemo(
    () => folders.filter((folder) => !folder.home).map((folder) => folder.path),
    [folders]
  );

  const save = useCallback(
    async (libraryPaths: string[]): Promise<boolean> => {
      setSaving(true);
      setError(undefined);
      try {
        await getTrpc().agents.update.mutate({
          id: agent.id,
          patch: {
            runtimeConfig: { ...agent.runtimeConfig, libraryPaths },
          },
        });
        await router.invalidate();
        toast.success("Saved");
        return true;
      } catch (cause) {
        setError(errorMessage(cause));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [agent.id, agent.runtimeConfig, router]
  );

  const openAdd = useCallback(() => setAdding(true), []);

  const changeDraft = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    []
  );

  const addFolder = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const next = nextLibraryPaths(extraPaths, draft);
      if ("error" in next) {
        setError(next.error);
        return;
      }
      if (await save(next.paths)) {
        setDraft("");
        setAdding(false);
      }
    },
    [draft, extraPaths, save]
  );

  const removeFolder = useCallback(
    (path: string) => {
      save(withoutPath(extraPaths, path));
    },
    [extraPaths, save]
  );

  return (
    <div className="flex flex-col gap-1.5">
      {folders.map((folder) => (
        <FolderLine
          disabled={saving}
          folder={folder}
          key={folder.path}
          onRemove={removeFolder}
        />
      ))}

      {adding ? (
        <form className="flex flex-col gap-1" onSubmit={addFolder}>
          <div className="flex items-center gap-2">
            <Input
              aria-invalid={error !== undefined}
              autoFocus
              disabled={saving}
              onChange={changeDraft}
              placeholder="finance/ or wiki/Finance"
              value={draft}
            />
            <Button disabled={saving} size="sm" type="submit">
              Add
            </Button>
          </div>
          {error === undefined ? null : (
            <p className="text-destructive text-xs">{error}</p>
          )}
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            className="rounded-full border-dashed"
            onClick={openAdd}
            size="sm"
            variant="outline"
          >
            + Add folder
          </Button>
          <span className="text-muted-foreground text-xs">{LIBRARY_NOTE}</span>
        </div>
      )}
    </div>
  );
}
