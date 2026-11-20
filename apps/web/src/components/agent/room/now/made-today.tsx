import type { ArtifactCard } from "@repo/protocol/artifacts";
import { Link } from "@tanstack/react-router";
import { ArtifactSlotRows } from "#/components/artifacts/list/artifacts-slot.tsx";
import {
  baseName,
  formatSize,
  parentDir,
} from "#/components/library/library-logic.ts";

export interface MadeFile {
  path: string;
  runId: string;
  size: number;
}

const SHOWN_MAX = 5;

const moreText = (hidden: number): string => `and ${hidden} more`;

/** The files and artifacts the agent's runs made today. Renders nothing when there are none. */
export function MadeToday({
  artifacts,
  files,
}: {
  artifacts: readonly ArtifactCard[];
  files: readonly MadeFile[];
}) {
  if (artifacts.length === 0 && files.length === 0) {
    return null;
  }
  const shownFiles = files.slice(0, SHOWN_MAX);
  const shownArtifacts = artifacts.slice(0, SHOWN_MAX);
  const hiddenFiles = files.length - shownFiles.length;
  const hiddenArtifacts = artifacts.length - shownArtifacts.length;
  return (
    <section
      aria-label="Made today"
      className="min-w-0 rounded-lg border border-border bg-card"
      data-testid="now-made-today"
    >
      <h2 className="px-4 py-3 font-semibold text-sm">Made today</h2>
      <div className="px-4 pb-3">
        {shownFiles.length === 0 ? null : (
          <ul className="flex flex-col">
            {shownFiles.map((file) => {
              const dir = parentDir(file.path);
              return (
                <li
                  className="flex pointer-coarse:min-h-10 min-w-0 pointer-coarse:items-center items-baseline gap-2 py-1 text-sm"
                  data-testid="made-file"
                  key={`${file.runId}:${file.path}`}
                >
                  <Link
                    className="min-w-0 flex-1 truncate underline underline-offset-2"
                    search={{
                      dir: dir === "" ? undefined : dir,
                      file: file.path,
                    }}
                    title={file.path}
                    to="/library"
                  >
                    {baseName(file.path)}
                  </Link>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {formatSize(file.size)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {hiddenFiles > 0 ? (
          <p className="text-muted-foreground text-xs">
            {moreText(hiddenFiles)}
          </p>
        ) : null}
        {shownArtifacts.length === 0 ? null : (
          <div className="mt-2 flex flex-col">
            <ArtifactSlotRows cards={shownArtifacts} />
          </div>
        )}
        {hiddenArtifacts > 0 ? (
          <p className="text-muted-foreground text-xs">
            {moreText(hiddenArtifacts)}
          </p>
        ) : null}
      </div>
    </section>
  );
}
