import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import { DialogFooter } from "#/components/ui/dialog";
import { errorMessage } from "#/lib/error-message";
import {
  missingRuntime,
  type StarterReview as Review,
  type StarterKey,
  TEAM_STARTERS,
} from "./starter-logic.ts";

export function StarterChoices({
  busy,
  onPick,
}: {
  busy: boolean;
  onPick: (key: StarterKey) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium text-sm">Start from a team starter</h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {TEAM_STARTERS.map((starter) => (
          <StarterCard
            busy={busy}
            key={starter.key}
            onPick={onPick}
            starter={starter}
          />
        ))}
      </div>
      <p className="text-muted-foreground text-xs">Or start a blank team.</p>
    </section>
  );
}

function StarterCard({
  busy,
  onPick,
  starter,
}: {
  busy: boolean;
  onPick: (key: StarterKey) => void;
  starter: (typeof TEAM_STARTERS)[number];
}) {
  const pick = useCallback(() => onPick(starter.key), [onPick, starter.key]);
  return (
    <button
      className="flex min-h-10 flex-col gap-1 rounded-lg border border-border bg-card p-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      disabled={busy}
      onClick={pick}
      type="button"
    >
      <span className="font-medium text-sm">{starter.title}</span>
      <span className="block text-muted-foreground text-xs">
        {starter.line}
      </span>
    </button>
  );
}

/** The starter's draft for review. Create makes the whole team in one call. */
export function StarterReview({
  onBack,
  onConfirm,
  review,
}: {
  onBack: () => void;
  onConfirm: (review: Review) => Promise<void>;
  review: Review;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noRuntime = missingRuntime(review);
  const [lead] = review.draft.members;
  const confirm = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await onConfirm(review);
    } catch (caught) {
      setError(errorMessage(caught));
      setSaving(false);
    }
  }, [onConfirm, review]);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="font-medium">{review.draft.name}</h3>
        <p className="text-muted-foreground text-sm">Lead: {lead?.name}</p>
      </div>
      <section className="flex flex-col gap-1">
        <h4 className="font-medium text-sm">Members</h4>
        <ul className="flex flex-col gap-1 text-sm">
          {review.draft.members.map((member) => (
            <li key={member.name}>
              <span className="font-medium">{member.name}</span>
              <span className="text-muted-foreground"> {member.does}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-1">
        <h4 className="font-medium text-sm">Rules</h4>
        <p className="whitespace-pre-line text-muted-foreground text-sm">
          {review.draft.rules}
        </p>
      </section>
      {noRuntime ? (
        <p className="text-destructive text-sm" role="alert">
          There is nowhere to run these agents yet.{" "}
          <a
            className="underline underline-offset-4"
            href="/settings/model-providers"
          >
            Add an API key in Settings
          </a>
          , then pick the starter again.
        </p>
      ) : null}
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button
          disabled={saving}
          onClick={onBack}
          type="button"
          variant="outline"
        >
          Back
        </Button>
        <Button disabled={saving || noRuntime} onClick={confirm} type="button">
          {saving ? "Creating" : "Create team"}
        </Button>
      </DialogFooter>
    </div>
  );
}
