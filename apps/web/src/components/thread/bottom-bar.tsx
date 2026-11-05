import { Button } from "#/components/ui/button.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import type { BottomState } from "../task/task-behaviour.ts";

export function BottomBar({
  state,
  pending,
  requestVisible,
  typing,
  onReview,
  onLatest,
  onStop,
  stopping,
  canStop,
  atBottom,
  runNumber,
  origin,
  routingHref,
  workingLabel,
}: {
  state: BottomState;
  pending: string | null;
  requestVisible: boolean;
  typing: boolean;
  onReview: () => void;
  onLatest: () => void;
  onStop: () => void;
  stopping: boolean;
  canStop: boolean;
  atBottom: boolean;
  runNumber: number;
  origin: string;
  routingHref?: string;
  workingLabel?: string;
}) {
  const waitingFor = pending === "question" ? "answer" : pending;
  if (state === "composer" || (state === "waiting" && typing)) {
    return null;
  }
  if (state === "routing") {
    return <RoutingBar href={routingHref} origin={origin} />;
  }
  if (state === "control") {
    return (
      <p className="border border-info/40 bg-info/10 p-3 text-info text-sm">
        You have control. Hand back on the computer{" "}
        <span className="md:hidden">tab</span>
        <span className="hidden md:inline">panel</span> when you are done.
      </p>
    );
  }
  if (state === "waiting") {
    return (
      <div className="flex items-center justify-between gap-3 border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
        <span>Waiting for your {waitingFor}</span>
        {requestVisible ? null : (
          <Button
            className="min-h-10 md:min-h-9"
            onClick={onReview}
            variant="ghost"
          >
            Go to the request
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 text-sm">
      <Spinner className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate">
          {workingLabel
            ? `Working · ${workingLabel}`
            : `Run ${runNumber} is working.`}
        </p>
        <p className="text-muted-foreground text-xs">Reply when it is done.</p>
      </div>
      {atBottom ? null : (
        <Button onClick={onLatest} variant="ghost">
          Jump to latest
        </Button>
      )}
      {canStop ? (
        <Button
          className="h-11 text-destructive md:hidden"
          disabled={stopping}
          onClick={onStop}
          variant="outline"
        >
          {stopping ? "Stopping…" : "Stop"}
        </Button>
      ) : null}
    </div>
  );
}

function RoutingBar({ origin, href }: { origin: string; href?: string }) {
  const mail = origin === "mail";
  const text: Record<string, string> = {
    mail: "Mail started this thread. Replies go by mail.",
    trigger: "A trigger started this thread, so it takes no replies here.",
  };
  return (
    <div className="text-muted-foreground text-sm">
      <span className={href ? "hidden md:inline" : undefined}>
        {text[origin] ?? "This thread takes no replies here."}
      </span>
      {href ? (
        <a
          className="flex min-h-12 w-full items-center underline focus-visible:ring-2 focus-visible:ring-ring md:ml-2 md:inline-flex md:min-h-9 md:w-auto"
          href={href}
        >
          <span className="mr-1 md:hidden">
            {mail ? "Mail thread ·" : "Trigger thread ·"}
          </span>
          {mail ? "Open the mail thread" : "Open the trigger"}
        </a>
      ) : null}
    </div>
  );
}
