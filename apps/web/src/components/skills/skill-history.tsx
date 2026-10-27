import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  errorMessage,
  formatMtime,
  isConflict,
} from "#/components/library/library-logic.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type {
  SkillDiffResult,
  SkillSummary,
  SkillVersion,
} from "#/integrations/trpc/types";
import { SkillDiff } from "./skill-diff.tsx";
import {
  type AgentNames,
  authorLabel,
  saveBase64File,
  statusLabel,
  versionLabel,
} from "./skills-logic.ts";

const STATUS_VARIANT: Record<
  SkillVersion["status"],
  "destructive" | "outline" | "secondary"
> = {
  approved: "outline",
  proposed: "secondary",
  rejected: "destructive",
};

const SELECT_CLASS =
  "h-8 pointer-coarse:h-10 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** The key this component shows, null after unmount. A late response is dropped unless its key is still shown. */
function useShownKey(key: string) {
  const shown = useRef<string | null>(null);
  useEffect(() => {
    shown.current = key;
    return () => {
      shown.current = null;
    };
  }, [key]);
  return shown;
}

interface Comparison {
  diff: SkillDiffResult;
  from: number;
  to: number;
}

interface SkillHistoryProps {
  agentNames: AgentNames;
  onChanged: () => void;
  reviewVersion?: number;
  skill: SkillSummary;
  versions: SkillVersion[];
}

/** The version history of one skill: download, restore, compare and review proposals. */
export function SkillHistory({
  agentNames,
  onChanged,
  reviewVersion,
  skill,
  versions,
}: SkillHistoryProps) {
  const skillId = skill.id;
  const shown = useShownKey(skillId);
  const [from, setFrom] = useState<number | undefined>();
  const [to, setTo] = useState<number | undefined>();
  const [comparison, setComparison] = useState<Comparison | undefined>();
  const [reviewing, setReviewing] = useState<number | undefined>(reviewVersion);
  const [error, setError] = useState<string | undefined>();

  const latestNumber = versions[0]?.number;
  const fromValue = from ?? versions[1]?.number ?? latestNumber;
  const toValue = to ?? latestNumber;
  const reviewed = versions.find((version) => version.number === reviewing);

  useEffect(() => {
    if (typeof reviewVersion === "number") {
      setReviewing(reviewVersion);
    }
  }, [reviewVersion]);

  const changeFrom = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      setFrom(Number(event.target.value)),
    []
  );

  const changeTo = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      setTo(Number(event.target.value)),
    []
  );

  const compare = useCallback(async () => {
    if (fromValue === undefined || toValue === undefined) {
      return;
    }
    setError(undefined);
    try {
      const diff = await getTrpc().skillStore.diff.query({
        from: fromValue,
        skillId,
        to: toValue,
      });
      if (shown.current === skillId) {
        setComparison({ diff, from: fromValue, to: toValue });
      }
    } catch (cause) {
      if (shown.current === skillId) {
        setError(errorMessage(cause));
      }
    }
  }, [fromValue, toValue, skillId, shown]);

  const download = useCallback(
    async (version: number) => {
      setError(undefined);
      try {
        const file = await getTrpc().skillStore.exportArchive.query({
          skillId,
          version,
        });
        saveBase64File(file.filename, file.data);
      } catch (cause) {
        if (shown.current === skillId) {
          setError(errorMessage(cause));
        }
      }
    },
    [skillId, shown]
  );

  const restore = useCallback(
    async (toVersion: number) => {
      setError(undefined);
      try {
        await getTrpc().skillStore.revert.mutate({ skillId, toVersion });
      } catch (cause) {
        if (shown.current === skillId) {
          setError(errorMessage(cause));
        }
        return;
      }
      onChanged();
    },
    [skillId, onChanged, shown]
  );

  const openReview = useCallback(
    (version: number) => setReviewing(version),
    []
  );

  const closeReview = useCallback(() => setReviewing(undefined), []);

  const reviewDone = useCallback(() => {
    setReviewing(undefined);
    onChanged();
  }, [onChanged]);

  if (latestNumber === undefined) {
    return <p className="text-muted-foreground text-sm">No versions yet.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {error === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <ul className="divide-y divide-border border-border border-y">
        {versions.map((version) => (
          <VersionRow
            agentNames={agentNames}
            isLatestApproved={version.number === skill.latestApprovedVersion}
            key={version.number}
            onDownload={download}
            onRestore={restore}
            onReview={openReview}
            version={version}
          />
        ))}
      </ul>

      {reviewed === undefined ? null : (
        <ReviewPanel
          agentNames={agentNames}
          key={reviewed.number}
          onClose={closeReview}
          onDone={reviewDone}
          skillId={skillId}
          version={reviewed}
        />
      )}

      <section className="flex flex-col gap-3">
        <h3 className="font-medium">Compare</h3>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            From
            <select
              className={SELECT_CLASS}
              data-testid="skill-diff-from"
              onChange={changeFrom}
              value={fromValue}
            >
              {versions.map((version) => (
                <option key={version.number} value={version.number}>
                  {versionLabel(version.number)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            To
            <select
              className={SELECT_CLASS}
              data-testid="skill-diff-to"
              onChange={changeTo}
              value={toValue}
            >
              {versions.map((version) => (
                <option key={version.number} value={version.number}>
                  {versionLabel(version.number)}
                </option>
              ))}
            </select>
          </label>
          <Button
            data-testid="skill-diff-show"
            onClick={compare}
            size="sm"
            type="button"
            variant="outline"
          >
            Compare
          </Button>
        </div>
        {comparison === undefined ? null : (
          <section className="flex flex-col gap-3">
            <h4 className="text-sm">
              {versionLabel(comparison.from)} to {versionLabel(comparison.to)}
            </h4>
            <SkillDiff diff={comparison.diff} />
          </section>
        )}
      </section>
    </div>
  );
}

function VersionRow({
  agentNames,
  isLatestApproved,
  onDownload,
  onRestore,
  onReview,
  version,
}: {
  agentNames: AgentNames;
  isLatestApproved: boolean;
  onDownload: (version: number) => Promise<void>;
  onRestore: (version: number) => Promise<void>;
  onReview: (version: number) => void;
  version: SkillVersion;
}) {
  const { number } = version;
  const download = useCallback(() => onDownload(number), [number, onDownload]);
  const restore = useCallback(() => onRestore(number), [number, onRestore]);
  const review = useCallback(() => onReview(number), [number, onReview]);

  return (
    <li className="flex flex-col gap-2 py-3" data-testid="skill-version-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{versionLabel(number)}</span>
        <Badge variant={STATUS_VARIANT[version.status]}>
          {statusLabel(version.status)}
        </Badge>
        {isLatestApproved ? <Badge>Latest approved</Badge> : null}
      </div>
      <p className="text-sm">{version.message}</p>
      <p className="text-muted-foreground text-sm">
        {authorLabel(version.author, agentNames)} ·{" "}
        {formatMtime(version.createdAt)}
        {version.parent === null
          ? null
          : ` · based on ${versionLabel(version.parent)}`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="skill-version-download"
          onClick={download}
          size="sm"
          type="button"
          variant="outline"
        >
          Download
        </Button>
        {version.status === "approved" ? (
          <RestoreVersion label={versionLabel(number)} onConfirm={restore} />
        ) : null}
        {version.status === "proposed" ? (
          <Button
            data-testid="skill-version-review"
            onClick={review}
            size="sm"
            type="button"
          >
            Review
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function RestoreVersion({
  label,
  onConfirm,
}: {
  label: string;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const openDialog = useCallback(() => setOpen(true), []);
  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <Button
        data-testid="skill-version-restore"
        onClick={openDialog}
        size="sm"
        type="button"
        variant="outline"
      >
        Restore
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            A new version is made with the files of {label}. The older versions
            stay in the history.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid="skill-version-restore-confirm"
            onClick={onConfirm}
          >
            Restore
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type ReviewContent =
  | { kind: "diff"; diff: SkillDiffResult }
  | { kind: "files"; paths: string[] };

/** A proposed version, with what it changes and the approve and reject buttons. */
function ReviewPanel({
  agentNames,
  onClose,
  onDone,
  skillId,
  version,
}: {
  agentNames: AgentNames;
  onClose: () => void;
  onDone: () => void;
  skillId: string;
  version: SkillVersion;
}) {
  const shown = useShownKey(skillId);
  const { number, parent } = version;
  const [content, setContent] = useState<ReviewContent | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [decideError, setDecideError] = useState<string | undefined>();
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const next: ReviewContent =
          parent === null
            ? {
                kind: "files",
                paths: (
                  await getTrpc().skillStore.show.query({
                    skillId,
                    version: number,
                  })
                ).files.map((file) => file.path),
              }
            : {
                diff: await getTrpc().skillStore.diff.query({
                  from: parent,
                  skillId,
                  to: number,
                }),
                kind: "diff",
              };
        if (shown.current === skillId) {
          setContent(next);
        }
      } catch (cause) {
        if (shown.current === skillId) {
          setLoadError(errorMessage(cause));
        }
      }
    };
    load();
  }, [shown, number, parent, skillId]);

  const decide = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setDecideError(undefined);
      setStale(false);
      try {
        await action();
      } catch (cause) {
        if (shown.current === skillId) {
          setDecideError(errorMessage(cause));
          setStale(isConflict(cause));
          setBusy(false);
        }
        return;
      }
      onDone();
    },
    [shown, onDone, skillId]
  );

  const approve = useCallback(
    () =>
      decide(() =>
        getTrpc().skillStore.approve.mutate({ skillId, version: number })
      ),
    [decide, skillId, number]
  );

  const reject = useCallback(
    () =>
      decide(() =>
        getTrpc().skillStore.reject.mutate({ skillId, version: number })
      ),
    [decide, skillId, number]
  );

  return (
    <section
      className="flex flex-col gap-4 rounded-lg border border-border p-4"
      data-testid="skill-review-panel"
    >
      <header className="flex flex-col gap-1">
        <h3 className="font-medium">Review {versionLabel(number)}</h3>
        <p className="text-sm">{version.message}</p>
        <p className="text-muted-foreground text-sm">
          {authorLabel(version.author, agentNames)}
        </p>
      </header>

      {loadError === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {loadError}
        </p>
      )}
      {content === undefined && loadError === undefined ? (
        <p className="text-muted-foreground text-sm">Loading...</p>
      ) : null}
      {content?.kind === "files" ? (
        <section className="flex flex-col gap-1">
          <h4 className="text-sm">New skill, files:</h4>
          <ul className="font-mono text-sm">
            {content.paths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {content?.kind === "diff" && parent !== null ? (
        <section className="flex flex-col gap-3">
          <h4 className="text-sm">Changes from {versionLabel(parent)}</h4>
          <SkillDiff diff={content.diff} />
        </section>
      ) : null}

      {decideError === undefined ? null : (
        <div className="flex flex-col gap-1">
          <p className="text-destructive text-sm" role="alert">
            {decideError}
          </p>
          {stale ? (
            <p className="text-destructive text-sm">
              Reject it and ask the agent to redo the change on the latest
              version.
            </p>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          data-testid="skill-version-approve"
          disabled={busy || content === undefined}
          onClick={approve}
          type="button"
        >
          Approve
        </Button>
        <Button
          data-testid="skill-version-reject"
          disabled={busy}
          onClick={reject}
          type="button"
          variant="destructive"
        >
          Reject
        </Button>
        <p className="text-muted-foreground text-sm">
          Also rejects proposals built on this one.
        </p>
        <Button
          className="ml-auto"
          onClick={onClose}
          type="button"
          variant="ghost"
        >
          Close
        </Button>
      </div>
    </section>
  );
}
