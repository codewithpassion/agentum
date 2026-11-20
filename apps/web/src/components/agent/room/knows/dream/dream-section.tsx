import type { DreamSchedule, RememberRules } from "@repo/db/shared";
import { useCallback } from "react";
import { DreamCard } from "./dream-card.tsx";
import { EarlierDreams } from "./earlier-dreams.tsx";
import type { DreamApi } from "./use-dream.ts";

/**
 * The dream diary at the top of the Knows tab: the latest dream, the schedule
 * and Dream now, and the earlier dreams. The schedule is one of the agent's
 * remember rules, so changing it saves the rules.
 */
export function DreamSection({
  agentName,
  canChange,
  disabled,
  dream,
  nowMs,
  rules,
  saving,
  setRules,
}: {
  agentName: string;
  /** Whether this person may start a dream and change the schedule: the owner or an admin. */
  canChange: boolean;
  /** An archived agent: nothing here acts. */
  disabled: boolean;
  dream: DreamApi;
  nowMs: number;
  rules: RememberRules;
  saving: boolean;
  setRules: (rules: RememberRules) => void;
}) {
  const changeSchedule = useCallback(
    (dreamSchedule: DreamSchedule) => setRules({ ...rules, dreamSchedule }),
    [rules, setRules]
  );
  const { error, pending, runNow, runs, undo } = dream;
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="dream-section">
      {error === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {runs === undefined ? null : (
        <>
          <DreamCard
            agentName={agentName}
            canChange={canChange}
            disabled={disabled}
            nowMs={nowMs}
            onRunNow={runNow}
            onSchedule={changeSchedule}
            onUndo={undo}
            pending={saving ? "schedule" : pending}
            runs={runs}
            schedule={rules.dreamSchedule}
          />
          <EarlierDreams nowMs={nowMs} runs={runs} />
        </>
      )}
    </div>
  );
}
