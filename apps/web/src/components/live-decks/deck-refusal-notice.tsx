import { DECK_STALE_ANCESTRY } from "@repo/protocol/deck";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert.tsx";
import { Button } from "#/components/ui/button.tsx";

/** True when the room refused the editor's offline changes after compaction. */
export const isStaleAncestry = (reason: string | undefined) =>
  reason === DECK_STALE_ANCESTRY;

export function DeckRefusalNotice({ onReload }: { onReload: () => void }) {
  return (
    <Alert data-testid="deck-offline-refusal" variant="destructive">
      <AlertTitle>Your offline changes couldn't be applied</AlertTitle>
      <AlertDescription>
        <p>
          The deck was tidied up, so the room refused edits built on its older
          state, such as changes made offline. Reload to continue with the
          current deck. Reloading discards those edits.
        </p>
        <Button onClick={onReload} size="sm" type="button">
          Reload deck
        </Button>
      </AlertDescription>
    </Alert>
  );
}
