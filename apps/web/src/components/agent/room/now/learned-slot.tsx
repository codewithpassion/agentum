import type { MemoryChange } from "@repo/db/shared";
import { learnedThisWeek } from "../knows/learned-logic.ts";
import { LearnedList } from "../knows/learned-this-week.tsx";
import { useMemory } from "../knows/use-memory.ts";

/** The card around the Knows tab's list of what the agent learned this week. Nothing renders for an empty list. */
export function LearnedCard({
  busyId,
  changes,
  disabled,
  nowMs,
  onUndo,
}: {
  busyId: string | null;
  changes: readonly MemoryChange[];
  disabled: boolean;
  nowMs: number;
  onUndo: (changeId: string) => void;
}) {
  if (changes.length === 0) {
    return null;
  }
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
          changes={changes}
          disabled={disabled}
          nowMs={nowMs}
          onUndo={onUndo}
        />
      </div>
    </section>
  );
}

/**
 * Learned this week, from the same memory reads as the Knows tab. It renders
 * nothing until the memory has loaded, and nothing when the week has no changes.
 */
export function LearnedSlot({ agentId }: { agentId: string }) {
  const memory = useMemory(agentId);
  const { data } = memory;
  if (data === undefined) {
    return null;
  }
  return (
    <LearnedCard
      busyId={memory.busyId}
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
