import {
  DESK_POLL_INTERVAL_MS,
  usePolledQuery,
} from "#/components/inbox/use-polled-query";
import { getTrpc } from "#/integrations/trpc/client";
import { RailLink } from "./rail-link.tsx";
import { openQuestionsLabel } from "./rail-logic.ts";

/** A quiet link to Q&A, shown only while questions are open. */
export function OpenQuestionsRow({
  count,
  onNavigate,
}: {
  count: number;
  onNavigate?: () => void;
}) {
  const label = openQuestionsLabel(count);
  if (label === null) {
    return null;
  }
  return (
    <RailLink
      className="flex min-h-10 items-center rounded-md px-2 text-muted-foreground text-sm no-underline hover:text-foreground md:min-h-8"
      href="/qa"
      onNavigate={onNavigate}
    >
      {label}
    </RailLink>
  );
}

/** The open question count, polled. Nothing while loading or after a failed poll. */
export function RailQuestions({ onNavigate }: { onNavigate?: () => void }) {
  const { data, error } = usePolledQuery(
    () => getTrpc().qa.openCount.query(),
    null,
    DESK_POLL_INTERVAL_MS
  );
  if (data === null || error !== null) {
    return null;
  }
  return <OpenQuestionsRow count={data} onNavigate={onNavigate} />;
}
