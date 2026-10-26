import { useCallback, useState } from "react";
import { errorMessage } from "#/components/library/library-logic.ts";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import {
  compareUrl,
  pinnedUrl,
  repoSlug,
  type SkillSource,
  shortSha,
} from "./github-source-logic.ts";

/** Where a skill came from on GitHub: the repository, the folder, and the pinned commit. */
export function SkillSourceLine({ source }: { source: SkillSource }) {
  const folder =
    source.path === null || source.path === "" ? "" : `/${source.path}`;
  return (
    <p className="text-muted-foreground text-sm" data-testid="skill-source">
      Source:{" "}
      <a
        className="underline hover:text-foreground"
        data-testid="skill-source-link"
        href={pinnedUrl(source)}
        rel="noreferrer"
        target="_blank"
      >
        {repoSlug(source.repoUrl)}
        {folder}
      </a>{" "}
      @ <code title={source.commitSha}>{shortSha(source.commitSha)}</code> (
      {source.ref})
    </p>
  );
}

/** Says a newer GitHub commit exists, and proposes it as a new version to review. */
export function SkillUpdateNotice({
  skillId,
  source,
  onProposed,
}: {
  skillId: string;
  source: SkillSource;
  onProposed: (version: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const review = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const version = await getTrpc().skillStore.importUpdate.mutate({
        skillId,
      });
      onProposed(version.number);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [skillId, onProposed]);

  const compare = compareUrl(source);
  if (compare === null || source.latestCommitSha === null) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted p-3 text-sm"
        data-testid="skill-update-notice"
      >
        <Badge variant="secondary">Update available</Badge>
        <span>
          <code>{shortSha(source.commitSha)}</code> to{" "}
          <code>{shortSha(source.latestCommitSha)}</code>
        </span>
        <a
          className="underline hover:text-foreground"
          data-testid="skill-update-compare"
          href={compare}
          rel="noreferrer"
          target="_blank"
        >
          Compare on GitHub
        </a>
        <Button
          data-testid="skill-update-review"
          disabled={busy}
          onClick={review}
          size="sm"
          type="button"
        >
          Review update
        </Button>
      </div>
      {error === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
