import type { SkillDiffResult } from "#/integrations/trpc/types";

export type DiffLineKind = "added" | "removed" | "hunk" | "plain";

/** The colour class of one unified diff line, from its first character. */
export const diffLineKind = (line: string): DiffLineKind => {
  const first = line.charAt(0);
  if (first === "+") {
    return "added";
  }
  if (first === "-") {
    return "removed";
  }
  if (first === "@") {
    return "hunk";
  }
  return "plain";
};

const LINE_CLASS: Record<DiffLineKind, string> = {
  added: "text-emerald-600 dark:text-emerald-400",
  hunk: "text-muted-foreground",
  plain: "",
  removed: "text-destructive",
};

function PathList({ label, paths }: { label: string; paths: string[] }) {
  if (paths.length === 0) {
    return null;
  }
  return (
    <section className="flex flex-col gap-1">
      <h3 className="font-medium text-sm">{label}</h3>
      <ul className="font-mono text-sm">
        {paths.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
    </section>
  );
}

/** The lines of a patch, each keyed by its offset in the text. Offsets never repeat. */
const patchLines = (patch: string) => {
  let offset = 0;
  return patch.split("\n").map((line) => {
    const entry = { key: offset, line };
    offset += line.length + 1;
    return entry;
  });
};

function Patch({ patch, path }: { patch: string; path: string }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="font-mono text-sm">{path}</h3>
      <pre className="overflow-x-auto rounded-lg border border-border p-2.5 text-xs leading-5">
        {patchLines(patch).map(({ key, line }) => (
          <span
            className={`block whitespace-pre ${LINE_CLASS[diffLineKind(line)]}`}
            key={key}
          >
            {line}
          </span>
        ))}
      </pre>
    </section>
  );
}

/** A skill diff: the added, removed and changed paths, then a unified diff of each text file. */
export function SkillDiff({ diff }: { diff: SkillDiffResult }) {
  const identical =
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    diff.patches.length === 0;
  return (
    <div className="flex flex-col gap-4" data-testid="skill-diff-view">
      {identical ? (
        <p className="text-muted-foreground text-sm">No differences.</p>
      ) : (
        <>
          <PathList label="Added" paths={diff.added} />
          <PathList label="Removed" paths={diff.removed} />
          <PathList label="Changed" paths={diff.changed} />
          {diff.patches.map((entry) => (
            <Patch key={entry.path} patch={entry.patch} path={entry.path} />
          ))}
        </>
      )}
    </div>
  );
}
