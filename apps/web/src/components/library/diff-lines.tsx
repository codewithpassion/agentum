import { useMemo } from "react";
import { type DiffLine, lineDiff } from "./library-logic.ts";

const DIFF_PREFIX: Record<DiffLine["kind"], string> = {
  add: "+ ",
  del: "- ",
  same: "  ",
};

const DIFF_CLASS: Record<DiffLine["kind"], string> = {
  add: "bg-green-500/15",
  del: "bg-red-500/15",
  same: "text-muted-foreground",
};

/** A line diff of `before` to `after`, deletes in red and adds in green. */
export function DiffLines({
  after,
  before,
  testId = "diff-lines",
}: {
  after: string;
  before: string;
  testId?: string;
}) {
  const lines = useMemo(() => {
    try {
      return lineDiff(before, after).map((line, key) => ({ ...line, key }));
    } catch {
      return null;
    }
  }, [before, after]);
  return (
    <pre
      className="max-h-96 overflow-auto rounded-lg border border-input p-2.5 font-mono text-sm"
      data-testid={testId}
    >
      {lines === null && (
        <span className="text-muted-foreground">
          This diff could not be computed.
        </span>
      )}
      {lines?.length === 0 && (
        <span className="text-muted-foreground">No changes.</span>
      )}
      {lines?.length
        ? lines.map((line) => (
            <div className={DIFF_CLASS[line.kind]} key={line.key}>
              {DIFF_PREFIX[line.kind]}
              {line.text}
            </div>
          ))
        : null}
    </pre>
  );
}
