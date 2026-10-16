export type Preset =
  | { kind: "everyMinutes"; minutes: number }
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "monthly"; day: number; hour: number; minute: number };

export const PRESET_KINDS: readonly Preset["kind"][] = [
  "everyMinutes",
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
];

export const PRESET_LABELS: Record<Preset["kind"], string> = {
  daily: "Daily",
  everyMinutes: "Every few minutes",
  hourly: "Hourly",
  monthly: "Monthly",
  weekdays: "Weekdays",
  weekly: "Weekly",
};

const checked = (
  name: string,
  value: number,
  min: number,
  max: number
): number => {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(
      `${name} must be an integer from ${min} to ${max}, got ${value}`
    );
  }
  return value;
};

/** The minute and hour fields, "M H". */
const clock = (hour: number, minute: number): string =>
  `${checked("minute", minute, 0, 59)} ${checked("hour", hour, 0, 23)}`;

export const compilePreset = (preset: Preset): string => {
  switch (preset.kind) {
    case "everyMinutes": {
      const minutes = checked("minutes", preset.minutes, 1, 59);
      return minutes === 1 ? "* * * * *" : `*/${minutes} * * * *`;
    }
    case "hourly":
      return `${checked("minute", preset.minute, 0, 59)} * * * *`;
    case "daily":
      return `${clock(preset.hour, preset.minute)} * * *`;
    case "weekdays":
      return `${clock(preset.hour, preset.minute)} * * 1-5`;
    case "weekly":
      return `${clock(preset.hour, preset.minute)} * * ${checked("weekday", preset.weekday, 0, 6)}`;
    case "monthly":
      return `${clock(preset.hour, preset.minute)} ${checked("day", preset.day, 1, 28)} * *`;
    default:
      throw new Error("Unknown preset kind");
  }
};
