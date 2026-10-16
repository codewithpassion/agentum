const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const INTEGER = /^\d+$/;

const toInt = (field: string, min: number, max: number): number | undefined => {
  if (!INTEGER.test(field)) {
    return;
  }
  const value = Number(field);
  return value >= min && value <= max ? value : undefined;
};

const pad = (value: number): string => value.toString().padStart(2, "0");

/** Minute field of a schedule that runs at no fixed time of day. */
const describeInterval = (minute: string): string | undefined => {
  if (minute === "*") {
    return "every minute";
  }
  if (minute.startsWith("*/")) {
    const minutes = toInt(minute.slice(2), 2, 59);
    return minutes === undefined ? undefined : `every ${minutes} minutes`;
  }
  const at = toInt(minute, 0, 59);
  return at === undefined ? undefined : `every hour at :${pad(at)}`;
};

const describeWeekly = (weekday: string, at: string): string | undefined => {
  if (weekday === "*") {
    return `every day ${at}`;
  }
  if (weekday === "1-5") {
    return `weekdays ${at}`;
  }
  const index = toInt(weekday, 0, 6);
  const name = index === undefined ? undefined : WEEKDAYS[index];
  return name === undefined ? undefined : `every ${name} ${at}`;
};

/** Schedules that run at a fixed time of day, in the given timezone. */
const describeFixedTime = (
  minute: string,
  hour: string,
  dayOfMonth: string,
  weekday: string,
  timezone: string
): string | undefined => {
  const h = toInt(hour, 0, 23);
  const m = toInt(minute, 0, 59);
  if (h === undefined || m === undefined) {
    return;
  }
  const at = `at ${pad(h)}:${pad(m)} ${timezone}`;
  if (dayOfMonth === "*") {
    return describeWeekly(weekday, at);
  }
  if (weekday !== "*") {
    return;
  }
  const day = toInt(dayOfMonth, 1, 31);
  return day === undefined ? undefined : `monthly on day ${day} ${at}`;
};

/**
 * Describes the cron patterns that `compilePreset` produces. Any other cron
 * text comes back unchanged.
 */
export const describeCron = (cron: string, timezone: string): string => {
  const fields = cron.split(" ");
  if (fields.length !== 5) {
    return cron;
  }
  const [minute = "", hour = "", dayOfMonth = "", month = "", weekday = ""] =
    fields;
  if (month !== "*") {
    return cron;
  }
  const description =
    hour === "*" && dayOfMonth === "*" && weekday === "*"
      ? describeInterval(minute)
      : describeFixedTime(minute, hour, dayOfMonth, weekday, timezone);
  return description ?? cron;
};
