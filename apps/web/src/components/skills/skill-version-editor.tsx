import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { TextField } from "#/components/ui/field";
import type { SkillFile, SkillFileInput, SkillVersion } from "#/lib/api";
import { useApi } from "#/lib/workspace-context";
import { SkillFilesEditor } from "./skill-files-editor";

/**
 * Editing a skill is publishing a new version (plan 5e, "New version"): the
 * files load from the version being viewed, the changelog says why this one
 * exists, and the version it started from is left exactly as it was.
 */

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

export function SkillVersionEditor({
  baseFiles,
  baseVersion,
  onCancel,
  onSaved,
  slug,
}: {
  baseFiles: SkillFile[];
  /** The version whose files this one starts from. */
  baseVersion: number;
  onCancel: () => void;
  onSaved: (version: SkillVersion) => Promise<void>;
  slug: string;
}) {
  const api = useApi();

  const [files, setFiles] = useState<SkillFileInput[] | null>(null);
  const [changelog, setChangelog] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all(
      baseFiles.map(async (file) => ({
        content: await api.readSkillFile(slug, baseVersion, file.path),
        path: file.path,
      }))
    )
      .then((loaded) => {
        if (live) {
          setFiles(loaded);
        }
      })
      .catch((cause: unknown) => {
        if (live) {
          setError(messageOf(cause, "Failed to load this version's files."));
        }
      });
    return () => {
      live = false;
    };
  }, [api, baseFiles, baseVersion, slug]);

  const onChangelogChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setChangelog(event.target.value),
    []
  );

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!files) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const published = await api.createSkillVersion(slug, {
          changelog: changelog.trim(),
          files,
        });
        await onSaved(published.version);
      } catch (cause) {
        setError(messageOf(cause, "Failed to publish this version."));
      } finally {
        setBusy(false);
      }
    },
    [api, changelog, files, onSaved, slug]
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <form className="mx-auto max-w-2xl space-y-5" onSubmit={submit}>
        <header className="space-y-1">
          <h2 className="m-0 font-semibold text-lg">Edit {slug}</h2>
          <p className="m-0 text-[var(--ws-muted)] text-xs">
            Saving publishes a new version. Version {baseVersion} stays exactly
            as it is, so an agent pinned to it is unaffected.
          </p>
        </header>

        <TextField
          hint="Why this version exists - the audit trail a fix leaves behind."
          label="Changelog"
          maxLength={1000}
          onChange={onChangelogChange}
          placeholder="Fixed: the script assumed bash, the sandbox runs sh."
          required
          value={changelog}
        />

        {files ? (
          <SkillFilesEditor files={files} onChange={setFiles} />
        ) : (
          <p className="m-0 text-[var(--ws-muted)] text-sm">Loading files…</p>
        )}

        {error ? (
          <p className="m-0 text-[var(--ws-danger)] text-xs" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button onClick={onCancel} variant="ghost">
            Cancel
          </Button>
          <Button disabled={busy || !files} type="submit" variant="primary">
            Save new version
          </Button>
        </div>
      </form>
    </div>
  );
}
