import type { JobSentence } from "@repo/db/shared";
import type { ReactElement } from "react";
import { useCallback } from "react";
import {
  CHIP_CLASS,
  TONE_CLASS,
} from "#/components/agent/profile/chip-list.tsx";
import { Button } from "#/components/ui/button";
import {
  canPause,
  canRunNow,
  type JobChipKind,
  jobChips,
  lastResultText,
} from "./job-logic.ts";

const ROW_CLASS =
  "flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3";
const DIMMED_ROW_CLASS = `${ROW_CLASS} opacity-70`;

const DOES_CHIP_CLASS = `inline-flex rounded-full border px-2.5 py-0.5 text-sm whitespace-normal [overflow-wrap:anywhere] ${TONE_CLASS.default}`;

const chipClassName = (kind: JobChipKind): string => {
  if (kind === "when") {
    return `${CHIP_CLASS} ${TONE_CLASS.on}`;
  }
  if (kind === "does") {
    return DOES_CHIP_CLASS;
  }
  return `${CHIP_CLASS} ${TONE_CLASS.default}`;
};

export interface JobRowProps {
  /** Disables the buttons while an action runs. */
  busy: boolean;
  job: JobSentence;
  nowMs: number | null;
  onEdit: (job: JobSentence) => void;
  /** Pauses when the job is enabled, resumes when it is paused. */
  onPause: (job: JobSentence) => void;
  onRunNow: (job: JobSentence) => void;
  /** Hides the buttons. */
  readOnly: boolean;
  showAgent: boolean;
}

/** One job as a sentence made of chips, with the last result and the actions. */
export function JobRow({
  job,
  nowMs,
  showAgent,
  busy,
  readOnly,
  onPause,
  onRunNow,
  onEdit,
}: JobRowProps): ReactElement {
  const chips = jobChips(job, { showAgent });
  const jobName = job.does || job.when;
  const failed = job.lastRunOk === false && job.lastRunAt !== null;
  const pauseVerb = job.enabled ? "Pause" : "Resume";

  const handlePause = useCallback(() => onPause(job), [job, onPause]);
  const handleRunNow = useCallback(() => onRunNow(job), [job, onRunNow]);
  const handleEdit = useCallback(() => onEdit(job), [job, onEdit]);

  return (
    <li className={job.enabled ? ROW_CLASS : DIMMED_ROW_CLASS}>
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((chip) => (
          <span
            className={chipClassName(chip.kind)}
            data-chip={chip.kind}
            key={chip.kind}
          >
            {chip.text}
          </span>
        ))}
        {job.enabled ? null : (
          <span
            className={`${CHIP_CLASS} ${TONE_CLASS.warn}`}
            data-chip="paused"
          >
            Paused
          </span>
        )}
      </div>
      <p
        className={`text-xs ${failed ? "text-destructive" : "text-muted-foreground"}`}
      >
        {lastResultText(job, nowMs)}
      </p>
      {readOnly ? null : (
        <div className="flex flex-wrap gap-2">
          {canPause(job) ? (
            <Button
              aria-label={`${pauseVerb} job: ${jobName}`}
              disabled={busy}
              onClick={handlePause}
              size="sm"
              type="button"
              variant="outline"
            >
              {pauseVerb}
            </Button>
          ) : null}
          <Button
            aria-label={`Edit job: ${jobName}`}
            disabled={busy}
            onClick={handleEdit}
            size="sm"
            type="button"
            variant="outline"
          >
            Edit
          </Button>
          {canRunNow(job) ? (
            <Button
              aria-label={`Run job now: ${jobName}`}
              disabled={busy}
              onClick={handleRunNow}
              size="sm"
              type="button"
              variant="outline"
            >
              Run now
            </Button>
          ) : null}
        </div>
      )}
    </li>
  );
}
