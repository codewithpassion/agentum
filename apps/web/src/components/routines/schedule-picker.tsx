import { useCallback } from "react";
import { Button } from "#/components/ui/button";
import { SelectField, TextField } from "#/components/ui/field";
import type { Schedule } from "#/lib/api";
import { cx } from "#/lib/cx";
import {
  formatInZone,
  formatUntil,
  nextRuns,
  WEEKDAY_NAMES,
} from "#/lib/schedule-format";
import {
  isValidTimeZone,
  MIN_INTERVAL_MINUTES,
  type ParsedSchedule,
  parseSchedule,
} from "#/modules/routines/schedule";

/**
 * The schedule picker: five shapes behind one control, and the next three
 * firings underneath it.
 *
 * The draft keeps every type's answer, not just the selected one, so flipping
 * between Daily and Weekly to see what each would do costs nothing. Turning a
 * draft into a schedule goes through the server's own `parseSchedule`, which is
 * why a refused draft explains itself in exactly the words the API would have
 * used - and why the preview can stop a "no future run" 400 before it happens.
 */

const PREVIEW_RUNS = 3;
const MINUTES_PER_HOUR = 60;
const NO_FUTURE_RUN = "This schedule has no future run.";

/** Every option offered by the picker's per-type controls. */
export interface ScheduleDraft {
  cronExpr: string;
  /** Text rather than a number so the field can be empty while being typed. */
  everyMinutes: string;
  onceAt: string;
  /** Shared by daily and weekly: "at what time" is one answer. */
  time: string;
  type: Schedule["type"];
  weekday: number;
  weekdaysOnly: boolean;
}

/** Ordered simplest-first, so the escape hatch is the last thing offered. */
const TYPE_OPTIONS: { label: string; value: Schedule["type"] }[] = [
  { label: "Once", value: "once" },
  { label: "Daily", value: "daily" },
  { label: "Weekly", value: "weekly" },
  { label: "Every N hours", value: "interval" },
  { label: "Cron", value: "cron" },
];

const INTERVAL_PRESETS = [15, 30, 60, 120, 360, 720, 1440] as const;

const presetLabel = (minutes: number): string => {
  if (minutes < MINUTES_PER_HOUR) {
    return `${minutes}m`;
  }
  return `${minutes / MINUTES_PER_HOUR}h`;
};

const TIME_ZONES: string[] = (() => {
  const supported = Intl.supportedValuesOf;
  if (typeof supported !== "function") {
    return [];
  }
  try {
    return [...supported("timeZone")];
  } catch {
    return [];
  }
})();

export const browserTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;

const pad = (value: number): string => String(value).padStart(2, "0");

/** `YYYY-MM-DDTHH:mm` off a local clock - the shape a "once" is stored in. */
const localDateTimeValue = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

const HOUR_MS = 3_600_000;

/** A new routine's starting point: tomorrow's 09:00, or an hour from now for a one-off. */
export const emptyDraft = (now: Date = new Date()): ScheduleDraft => ({
  cronExpr: "0 9 * * 1-5",
  everyMinutes: "60",
  onceAt: localDateTimeValue(new Date(now.getTime() + HOUR_MS)),
  time: "09:00",
  type: "daily",
  weekday: 1,
  weekdaysOnly: false,
});

/** An existing routine's schedule back into a draft, leaving the rest at defaults. */
export const draftFromSchedule = (
  schedule: Schedule | null,
  now: Date = new Date()
): ScheduleDraft => {
  const draft = emptyDraft(now);
  if (!schedule) {
    return draft;
  }
  switch (schedule.type) {
    case "once":
      return { ...draft, onceAt: schedule.at, type: "once" };
    case "daily":
      return {
        ...draft,
        time: schedule.time,
        type: "daily",
        weekdaysOnly: schedule.weekdaysOnly === true,
      };
    case "weekly":
      return {
        ...draft,
        time: schedule.time,
        type: "weekly",
        weekday: schedule.day,
      };
    case "interval":
      return {
        ...draft,
        everyMinutes: String(schedule.everyMinutes),
        type: "interval",
      };
    default:
      return { ...draft, cronExpr: schedule.expr, type: "cron" };
  }
};

const rawOf = (draft: ScheduleDraft): Record<string, unknown> => {
  switch (draft.type) {
    case "once":
      return { at: draft.onceAt, type: "once" };
    case "daily":
      return {
        time: draft.time,
        type: "daily",
        weekdaysOnly: draft.weekdaysOnly,
      };
    case "weekly":
      return { day: draft.weekday, time: draft.time, type: "weekly" };
    case "interval":
      return {
        everyMinutes: Number.parseInt(draft.everyMinutes, 10),
        type: "interval",
      };
    default:
      return { expr: draft.cronExpr, type: "cron" };
  }
};

/** The draft as the API would read it, refusal reason and all. */
export const scheduleFromDraft = (draft: ScheduleDraft): ParsedSchedule =>
  parseSchedule(rawOf(draft));

// --- the per-type controls --------------------------------------------------

interface ControlProps {
  draft: ScheduleDraft;
  onChange: (changes: Partial<ScheduleDraft>) => void;
}

function OnceControls({ draft, onChange }: ControlProps) {
  const set = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      onChange({ onceAt: event.target.value }),
    [onChange]
  );
  return (
    <TextField
      data-testid="schedule-once-at"
      hint="Read in the routine's time zone, below."
      label="Date and time"
      onChange={set}
      type="datetime-local"
      value={draft.onceAt}
    />
  );
}

function DailyControls({ draft, onChange }: ControlProps) {
  const setTime = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      onChange({ time: event.target.value }),
    [onChange]
  );
  const setWeekdaysOnly = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      onChange({ weekdaysOnly: event.target.checked }),
    [onChange]
  );
  return (
    <div className="space-y-2">
      <TextField
        data-testid="schedule-daily-time"
        label="Time"
        onChange={setTime}
        type="time"
        value={draft.time}
      />
      <label className="flex items-center gap-2 text-[var(--ws-text)] text-sm">
        <input
          checked={draft.weekdaysOnly}
          className="ws-focus"
          onChange={setWeekdaysOnly}
          type="checkbox"
        />
        Weekdays only (Monday to Friday)
      </label>
    </div>
  );
}

function WeeklyControls({ draft, onChange }: ControlProps) {
  const setDay = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) =>
      onChange({ weekday: Number(event.target.value) }),
    [onChange]
  );
  const setTime = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      onChange({ time: event.target.value }),
    [onChange]
  );
  return (
    <div className="space-y-2">
      <SelectField label="Day" onChange={setDay} value={String(draft.weekday)}>
        {WEEKDAY_NAMES.map((name, index) => (
          <option key={name} value={String(index)}>
            {name}
          </option>
        ))}
      </SelectField>
      <TextField
        label="Time"
        onChange={setTime}
        type="time"
        value={draft.time}
      />
    </div>
  );
}

function PresetButton({
  minutes,
  onPick,
  selected,
}: {
  minutes: number;
  onPick: (minutes: number) => void;
  selected: boolean;
}) {
  const pick = useCallback(() => onPick(minutes), [minutes, onPick]);
  return (
    <Button onClick={pick} size="sm" variant={selected ? "primary" : "subtle"}>
      {presetLabel(minutes)}
    </Button>
  );
}

function IntervalControls({ draft, onChange }: ControlProps) {
  const setMinutes = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      onChange({ everyMinutes: event.target.value }),
    [onChange]
  );
  const pick = useCallback(
    (minutes: number) => onChange({ everyMinutes: String(minutes) }),
    [onChange]
  );
  return (
    <div className="space-y-2">
      <TextField
        data-testid="schedule-interval-minutes"
        hint={`Minutes between runs, ${MIN_INTERVAL_MINUTES} at the least.`}
        label="Every"
        min={MIN_INTERVAL_MINUTES}
        onChange={setMinutes}
        step={5}
        type="number"
        value={draft.everyMinutes}
      />
      <div className="flex flex-wrap gap-1.5">
        {INTERVAL_PRESETS.map((minutes) => (
          <PresetButton
            key={minutes}
            minutes={minutes}
            onPick={pick}
            selected={draft.everyMinutes === String(minutes)}
          />
        ))}
      </div>
    </div>
  );
}

function CronControls({ draft, onChange }: ControlProps) {
  const set = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      onChange({ cronExpr: event.target.value }),
    [onChange]
  );
  return (
    <TextField
      data-testid="schedule-cron-expr"
      hint="minute hour day-of-month month day-of-week — e.g. 0 9 * * 1-5. No names, macros or L/W/#."
      label="Cron expression"
      onChange={set}
      spellCheck={false}
      value={draft.cronExpr}
    />
  );
}

function TypeControls(props: ControlProps) {
  switch (props.draft.type) {
    case "once":
      return <OnceControls {...props} />;
    case "daily":
      return <DailyControls {...props} />;
    case "weekly":
      return <WeeklyControls {...props} />;
    case "interval":
      return <IntervalControls {...props} />;
    default:
      return <CronControls {...props} />;
  }
}

// --- the preview ------------------------------------------------------------

function PreviewNote({ danger, text }: { danger: boolean; text: string }) {
  return (
    <p
      className={cx(
        "m-0 text-xs",
        danger ? "text-[var(--ws-danger)]" : "text-[var(--ws-muted)]"
      )}
      data-testid="schedule-preview"
    >
      {text}
    </p>
  );
}

/**
 * The next three firings, computed here with the same `nextRun` the scheduler
 * uses. A schedule that cannot be read, or that has already been and gone, says
 * so here rather than as a 400 after you press save.
 */
export function NextRunsPreview({
  draft,
  timezone,
}: {
  draft: ScheduleDraft;
  timezone: string;
}) {
  const parsed = scheduleFromDraft(draft);
  if (!parsed.ok) {
    return <PreviewNote danger text={parsed.reason} />;
  }
  if (!isValidTimeZone(timezone)) {
    return (
      <PreviewNote danger text={`"${timezone}" is not a known time zone.`} />
    );
  }

  const runs = nextRuns(parsed.schedule, timezone, PREVIEW_RUNS);
  if (runs.length === 0) {
    return <PreviewNote danger text={NO_FUTURE_RUN} />;
  }

  return (
    <div className="space-y-1" data-testid="schedule-preview">
      <p className="m-0 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
        Next {runs.length === 1 ? "run" : `${runs.length} runs`}
      </p>
      <ul className="m-0 list-none space-y-0.5 p-0">
        {runs.map((run) => (
          <li className="text-[var(--ws-text)] text-xs" key={run.toISOString()}>
            {formatInZone(run.getTime(), timezone)}{" "}
            <span className="text-[var(--ws-muted)]">
              ({formatUntil(run.getTime())})
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- the picker -------------------------------------------------------------

export function SchedulePicker({
  draft,
  onDraftChange,
  onTimezoneChange,
  timezone,
}: {
  draft: ScheduleDraft;
  onDraftChange: (draft: ScheduleDraft) => void;
  onTimezoneChange: (timezone: string) => void;
  timezone: string;
}) {
  const patch = useCallback(
    (changes: Partial<ScheduleDraft>) =>
      onDraftChange({ ...draft, ...changes }),
    [draft, onDraftChange]
  );
  const setType = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) =>
      patch({ type: event.target.value as Schedule["type"] }),
    [patch]
  );
  const setTimezone = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      onTimezoneChange(event.target.value),
    [onTimezoneChange]
  );

  return (
    <div className="space-y-3 rounded-lg border border-[var(--ws-line)] p-3">
      <SelectField
        data-testid="schedule-type"
        label="Schedule"
        onChange={setType}
        value={draft.type}
      >
        {TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>

      <TypeControls draft={draft} onChange={patch} />

      <TextField
        data-testid="schedule-timezone"
        hint="An IANA zone, defaulted from this browser."
        label="Time zone"
        list={TIME_ZONES.length > 0 ? "routine-time-zones" : undefined}
        onChange={setTimezone}
        spellCheck={false}
        value={timezone}
      />
      {TIME_ZONES.length > 0 ? (
        <datalist id="routine-time-zones">
          {TIME_ZONES.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      ) : null}

      <NextRunsPreview draft={draft} timezone={timezone} />
    </div>
  );
}
