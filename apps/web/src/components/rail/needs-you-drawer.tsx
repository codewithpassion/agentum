import { useCallback } from "react";
import type { PinnedArtifact } from "#/components/artifacts/pinned/pinned-logic";
import { PinnedSidebarGroup } from "#/components/artifacts/pinned/pinned-sidebar";
import { useTaskControl } from "#/components/task/task-control.ts";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import { RailLink } from "./rail-link.tsx";
import { needsYouLabel } from "./rail-logic.ts";
import { NeedsYouRow } from "./rail-needs-you.tsx";
import { RailQuestions } from "./rail-questions.tsx";
import { ScopeToggle } from "./rail-scope-toggle.tsx";
import { WorkingList } from "./rail-working.tsx";
import type { NeedsYouState } from "./use-needs-you.ts";

const SECTION_HEADING_CLASS =
  "flex justify-between px-2 pt-3 pb-1.5 font-medium text-muted-foreground text-[13px]";

interface NeedsYouListProps {
  onNavigate: () => void;
  pinned: readonly PinnedArtifact[];
  state: NeedsYouState;
}

/** What waits on you, what is running, and what you pinned. */
export function NeedsYouList({ onNavigate, pinned, state }: NeedsYouListProps) {
  const control = useTaskControl();
  const {
    actionable,
    count,
    error,
    fresh,
    openId,
    scope,
    setScope,
    showToggle,
    view,
  } = state;
  const now = new Date();
  const countLabel = needsYouLabel(count);

  return (
    <div className="flex flex-col">
      {showToggle && scope !== null ? (
        <ScopeToggle
          counts={view === null ? null : view.counts}
          onSelect={setScope}
          scope={scope}
        />
      ) : null}
      {control ? (
        <RailLink
          className="mx-1 my-2 border border-info/40 border-l-[3px] border-l-info bg-info/10 p-2 text-info text-sm focus-visible:ring-2 focus-visible:ring-ring"
          href={`/tasks/${control.runId}#computer`}
          onNavigate={onNavigate}
        >
          <span className="block font-medium">You have control</span>
          <span className="text-xs">{control.agentName}'s computer</span>
        </RailLink>
      ) : null}
      <h2 className={SECTION_HEADING_CLASS}>
        Needs you
        <span>{countLabel}</span>
      </h2>
      <div className="flex flex-col gap-1.5">
        {actionable.map((item) => (
          <NeedsYouRow
            fresh={fresh.has(item.id)}
            item={item}
            key={item.id}
            now={now}
            onNavigate={onNavigate}
            open={item.id === openId}
            scope={scope ?? "mine"}
          />
        ))}
        {view !== null && actionable.length === 0 ? (
          <p className="px-2 py-1 text-muted-foreground text-sm">
            Nothing needs you.
          </p>
        ) : null}
        {view === null && error === null ? (
          <p className="px-2 py-1 text-muted-foreground text-sm">Loading</p>
        ) : null}
        {view === null && error !== null ? (
          <p className="px-2 py-1 text-destructive text-sm" role="alert">
            Could not load your list.
          </p>
        ) : null}
      </div>
      {view === null ? null : (
        <RailLink
          className="mt-2 flex min-h-10 items-center rounded-md px-2 text-muted-foreground text-sm no-underline hover:text-foreground md:min-h-8"
          href="/desk?view=board"
          onNavigate={onNavigate}
        >
          {view.doneToday} done today
        </RailLink>
      )}
      <RailQuestions onNavigate={onNavigate} />
      <PinnedSidebarGroup onNavigate={onNavigate} pins={pinned} />
      <WorkingList
        onNavigate={onNavigate}
        runs={view === null ? [] : view.working}
      />
    </div>
  );
}

interface NeedsYouDrawerProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  pinned: readonly PinnedArtifact[];
  state: NeedsYouState;
}

/** The Needs you list as a left-side drawer, opened from the top bar. */
export function NeedsYouDrawer({
  onOpenChange,
  open,
  pinned,
  state,
}: NeedsYouDrawerProps) {
  const closeDrawer = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-sm" side="left">
        <SheetHeader className="border-border border-b pr-12">
          <SheetTitle>Needs you</SheetTitle>
          <SheetDescription className="sr-only">
            What waits on you, what is running, and what you pinned.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <NeedsYouList
            onNavigate={closeDrawer}
            pinned={pinned}
            state={state}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
