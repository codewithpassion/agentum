import type { DeskCard } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { conflictStatusText } from "#/components/desk/desk-logic.ts";
import { DiffLines } from "#/components/library/diff-lines.tsx";
import { Button, buttonVariants } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";

type Choice = "keep-library" | "keep-agent";

interface ConflictPaths {
  conflictPath: string;
  path: string;
}

type Comparison =
  | { kind: "binary" }
  | { kind: "text"; agentText: string; libraryText: string };

function OpenTaskLink({ runId }: { runId: string }) {
  return (
    <Link
      className={buttonVariants({ size: "sm", variant: "outline" })}
      params={{ runId }}
      to="/tasks/$runId"
    >
      Open task
    </Link>
  );
}

function ConflictBody({
  card,
  conflict,
  onChanged,
}: {
  card: DeskCard;
  conflict: ConflictPaths;
  onChanged: () => void;
}) {
  const { conflictPath, path } = conflict;
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleCompare = useCallback(async () => {
    if (comparison !== null) {
      setComparison(null);
      return;
    }
    setError(null);
    try {
      const trpc = getTrpc();
      const [library, agent] = await Promise.all([
        trpc.library.read.query({ path }),
        trpc.library.read.query({ path: conflictPath }),
      ]);
      setComparison(
        library.text === null || agent.text === null
          ? { kind: "binary" }
          : {
              agentText: agent.text,
              kind: "text",
              libraryText: library.text,
            }
      );
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [comparison, conflictPath, path]);

  const decide = useCallback(
    async (choice: Choice) => {
      setPending(true);
      setError(null);
      try {
        await getTrpc().library.conflicts.resolve.mutate({
          choice,
          id: card.id,
        });
        onChanged();
      } catch (failure) {
        setError(errorMessage(failure));
      } finally {
        setPending(false);
      }
    },
    [card.id, onChanged]
  );

  const keepLibrary = useCallback(() => {
    decide("keep-library");
  }, [decide]);

  const keepAgent = useCallback(() => {
    decide("keep-agent");
  }, [decide]);

  return (
    <div className="flex flex-col gap-3" data-testid="conflict-resolver">
      <p className="text-muted-foreground text-xs">
        {conflictStatusText(card.title)}
      </p>
      <p className="font-mono text-xs">{path}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="conflict-compare"
          onClick={toggleCompare}
          size="sm"
          variant="outline"
        >
          Compare
        </Button>
        {card.runId === undefined ? null : <OpenTaskLink runId={card.runId} />}
        <Button
          data-testid="conflict-keep-library"
          disabled={pending}
          onClick={keepLibrary}
          size="sm"
        >
          Keep library version
        </Button>
        <Button
          data-testid="conflict-keep-agent"
          disabled={pending}
          onClick={keepAgent}
          size="sm"
        >
          Keep agent version
        </Button>
      </div>
      {comparison === null ? null : <ComparisonView comparison={comparison} />}
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ComparisonView({ comparison }: { comparison: Comparison }) {
  if (comparison.kind === "binary") {
    return (
      <p className="text-muted-foreground text-sm">
        These files are not text, so they cannot be compared.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground text-xs">
        Library version to agent version
      </p>
      <DiffLines
        after={comparison.agentText}
        before={comparison.libraryText}
        testId="conflict-diff"
      />
    </div>
  );
}

/** A library conflict on the Needs you lane: compare the two copies, then keep one. */
export function ConflictResolver({
  card,
  onChanged,
}: {
  card: DeskCard;
  onChanged: () => void;
}) {
  const [conflict, setConflict] = useState<ConflictPaths | null | undefined>(
    undefined
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getTrpc()
      .library.conflicts.list.query()
      .then(
        (rows) => {
          if (!active) {
            return;
          }
          const row = rows.find((candidate) => candidate.id === card.id);
          setConflict(
            row === undefined
              ? null
              : { conflictPath: row.conflictPath, path: row.path }
          );
        },
        (failure: unknown) => {
          if (active) {
            setLoadError(errorMessage(failure));
          }
        }
      );
    return () => {
      active = false;
    };
  }, [card.id]);

  const resolved = conflict === null;

  useEffect(() => {
    if (resolved) {
      onChanged();
    }
  }, [resolved, onChanged]);

  if (conflict === null) {
    return (
      <p className="text-muted-foreground text-sm">
        This conflict is already resolved.
      </p>
    );
  }
  if (conflict === undefined) {
    return loadError === null ? (
      <p className="text-muted-foreground text-sm">Loading conflict...</p>
    ) : (
      <p className="text-destructive text-sm" role="alert">
        {loadError}
      </p>
    );
  }
  return <ConflictBody card={card} conflict={conflict} onChanged={onChanged} />;
}
