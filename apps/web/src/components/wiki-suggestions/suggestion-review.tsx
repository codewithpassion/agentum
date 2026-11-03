import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { runOnSendShortcut } from "#/components/composer/send-shortcut.ts";
import { SubmitKeys } from "#/components/composer/submit-keys.tsx";
import {
  type SuggestionStatus,
  suggestionStatusText,
} from "#/components/desk/desk-logic.ts";
import { DiffLines } from "#/components/library/diff-lines.tsx";
import { errorMessage } from "#/components/triggers/format.ts";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { reviewDiff } from "./suggestion-review-logic.ts";

type SuggestionState = "pending" | "stale" | "accepted" | "rejected";

interface LoadedSuggestion {
  baseText: string;
  currentText: string;
  path: string;
  proposedText: string;
  status: SuggestionState;
  summary: string;
}

const isOpenStatus = (status: SuggestionState): status is SuggestionStatus =>
  status === "pending" || status === "stale";

/** Lets a person accept, edit then accept, or reject one agent-suggested wiki edit. */
export function SuggestionReview({
  agentName,
  id,
  onDecided,
}: {
  agentName: string;
  id: string;
  onDecided: () => void;
}) {
  const [suggestion, setSuggestion] = useState<LoadedSuggestion | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const notifiedRef = useRef(false);

  const fetchSuggestion = useCallback(
    (): Promise<LoadedSuggestion> =>
      getTrpc().wiki.suggestions.get.query({ id }),
    [id]
  );

  useEffect(() => {
    // A reply for a suggestion the person has already left is dropped.
    let current = true;
    setSuggestion(null);
    setLoadError(null);
    fetchSuggestion().then(
      (result) => {
        if (current) {
          setSuggestion(result);
        }
      },
      (cause: unknown) => {
        if (current) {
          setLoadError(errorMessage(cause));
        }
      }
    );
    return () => {
      current = false;
    };
  }, [fetchSuggestion]);

  const refresh = useCallback(async () => {
    try {
      setSuggestion(await fetchSuggestion());
    } catch (cause) {
      setLoadError(errorMessage(cause));
    }
  }, [fetchSuggestion]);

  const decided = suggestion !== null && !isOpenStatus(suggestion.status);

  useEffect(() => {
    if (decided && !notifiedRef.current) {
      notifiedRef.current = true;
      onDecided();
    }
  }, [decided, onDecided]);

  const handleAccept = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      await getTrpc().wiki.suggestions.decide.mutate({ accept: true, id });
      onDecided();
    } catch (cause) {
      setActionError(errorMessage(cause));
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [id, onDecided, refresh]);

  const handleReject = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      await getTrpc().wiki.suggestions.decide.mutate({ id, reject: true });
      onDecided();
    } catch (cause) {
      setActionError(errorMessage(cause));
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [id, onDecided, refresh]);

  const handleEditOpen = useCallback(() => {
    setDraft(suggestion?.proposedText ?? "");
    setEditError(null);
    setEditOpen(true);
  }, [suggestion]);

  const handleEditOpenChange = useCallback((next: boolean) => {
    setEditOpen(next);
  }, []);

  const handleDraftChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setDraft(event.target.value);
    },
    []
  );

  const handleCancelEdit = useCallback(() => {
    setEditOpen(false);
  }, []);

  const handleAcceptEdited = useCallback(async () => {
    setBusy(true);
    setEditError(null);
    try {
      await getTrpc().wiki.suggestions.decide.mutate({
        accept: true,
        body: draft,
        id,
      });
      setEditOpen(false);
      onDecided();
    } catch (cause) {
      setEditError(errorMessage(cause));
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [draft, id, onDecided, refresh]);

  if (suggestion === null) {
    return loadError === null ? (
      <p className="text-muted-foreground text-sm">Loading...</p>
    ) : (
      <p className="text-destructive text-sm" role="alert">
        {loadError}
      </p>
    );
  }

  const { status } = suggestion;
  if (!isOpenStatus(status)) {
    return <p className="text-muted-foreground text-sm">Already decided.</p>;
  }

  const review = reviewDiff({
    baseText: suggestion.baseText,
    currentText: suggestion.currentText,
    proposedText: suggestion.proposedText,
    status,
  });

  return (
    <section
      aria-label={`Suggestion from ${agentName}`}
      className="flex flex-col gap-3"
      data-testid="suggestion-review"
    >
      <p className="text-muted-foreground text-xs">
        {suggestionStatusText(status, suggestion.summary)}
      </p>
      <p className="font-mono text-xs">{suggestion.path}</p>
      {review.note === null ? null : (
        <p className="text-sm" data-testid="suggestion-stale-note" role="note">
          {review.note}
        </p>
      )}
      <DiffLines
        after={review.after}
        before={review.before}
        testId="suggestion-diff"
      />
      {loadError === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {loadError}
        </p>
      )}
      {actionError === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {actionError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {status === "pending" ? (
          <Button
            data-testid="suggestion-accept"
            disabled={busy}
            onClick={handleAccept}
            size="sm"
            type="button"
          >
            Accept
          </Button>
        ) : null}
        <Button
          data-testid="suggestion-edit"
          disabled={busy}
          onClick={handleEditOpen}
          size="sm"
          type="button"
          variant="outline"
        >
          Edit first
        </Button>
        <Button
          data-testid="suggestion-reject"
          disabled={busy}
          onClick={handleReject}
          size="sm"
          type="button"
          variant="outline"
        >
          Reject
        </Button>
      </div>
      <Dialog onOpenChange={handleEditOpenChange} open={editOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit suggestion for {suggestion.path}</DialogTitle>
          </DialogHeader>
          <textarea
            aria-label="Edited page"
            className="w-full rounded-lg border border-input bg-transparent p-2.5 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            data-testid="suggestion-editor"
            onChange={handleDraftChange}
            onKeyDown={runOnSendShortcut(!busy, handleAcceptEdited)}
            rows={20}
            spellCheck={false}
            value={draft}
          />
          {editError === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {editError}
            </p>
          )}
          <DialogFooter>
            <Button onClick={handleCancelEdit} type="button" variant="outline">
              Cancel
            </Button>
            <Button
              data-testid="suggestion-accept-edited"
              disabled={busy}
              onClick={handleAcceptEdited}
              type="button"
            >
              Accept edited text
              <SubmitKeys />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
