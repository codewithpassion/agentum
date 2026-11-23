import { useAuth } from "@clerk/tanstack-react-start";
import type { MemoryChange } from "@repo/db/shared";
import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import { learnedThisWeek } from "../knows/learned-logic.ts";
import { LearnedList } from "../knows/learned-this-week.tsx";
import { canChangeRules } from "../knows/rules-logic.ts";
import { useMemory } from "../knows/use-memory.ts";
import type { RoomData } from "../room-data.ts";

const COLLAPSED_COUNT = 3;

/** The card around the Knows tab's list of what the agent learned this week. Shows the newest three until expanded. Nothing renders for an empty list. */
export function LearnedCard({
  busyId,
  canChange,
  changes,
  disabled,
  nowMs,
  onUndo,
}: {
  busyId: string | null;
  /** Whether this person may undo changes to shared notes: the owner or an admin. */
  canChange: boolean;
  changes: readonly MemoryChange[];
  disabled: boolean;
  nowMs: number;
  onUndo: (changeId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  if (changes.length === 0) {
    return null;
  }
  const isLong = changes.length > COLLAPSED_COUNT;
  const shown =
    expanded || !isLong ? changes : changes.slice(0, COLLAPSED_COUNT);
  return (
    <section
      aria-label="Learned this week"
      className="min-w-0 rounded-lg border border-border bg-card"
      data-testid="now-learned"
    >
      <h2 className="px-4 py-3 font-semibold text-sm">Learned this week</h2>
      <div className="px-4 pb-3 text-sm">
        <LearnedList
          busyId={busyId}
          canChange={canChange}
          changes={shown}
          clamp={true}
          disabled={disabled}
          nowMs={nowMs}
          onUndo={onUndo}
        />
        {isLong ? (
          <Button
            aria-expanded={expanded}
            onClick={toggle}
            size="sm"
            type="button"
            variant="ghost"
          >
            {expanded ? "Show less" : `Show all (${changes.length})`}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Learned this week, from the same memory reads as the Knows tab. It renders
 * nothing until the memory has loaded, and nothing when the week has no changes.
 */
export function LearnedSlot({ agent }: { agent: RoomData["agent"] }) {
  const { orgRole, userId } = useAuth();
  const memory = useMemory(agent.id);
  const { data } = memory;
  if (data === undefined) {
    return null;
  }
  return (
    <LearnedCard
      busyId={memory.busyId}
      canChange={canChangeRules({
        isAdmin: orgRole === "org:admin",
        ownerUserId: agent.ownerUserId ?? agent.createdBy,
        userId: userId ?? null,
      })}
      changes={learnedThisWeek(
        data.changes,
        data.nowMs,
        data.rules.agent.learnLevel
      )}
      disabled={false}
      nowMs={data.nowMs}
      onUndo={memory.undo}
    />
  );
}
