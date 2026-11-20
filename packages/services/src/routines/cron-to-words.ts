import { parseCron } from "./cron.ts";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WHITESPACE = /\s+/;
const INTEGER = /^\d+$/;
const MINUTE_STEP = /^\*\/\d+$/;
const pad = (n: number) => String(n).padStart(2, "0");

const joinDays = (days: string[]): string =>
  days.length < 3
    ? days.join(" and ")
    : `${days.slice(0, -1).join(", ")} and ${days.at(-1)}`;

const describeInterval = (minute: string): string | null => {
  if (minute === "*") {
    return "Every minute";
  }
  if (MINUTE_STEP.test(minute)) {
    const step = Number(minute.slice(2));
    return step === 1 ? "Every minute" : `Every ${step} minutes`;
  }
  return INTEGER.test(minute) ? `Every hour at :${pad(Number(minute))}` : null;
};

const describe = (cron: string): string | null => {
  const parsed = parseCron(cron);
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = cron
    .trim()
    .split(WHITESPACE);
  if (hour === "*" && day === "*" && month === "*" && weekday === "*") {
    return describeInterval(minute);
  }
  if (!(INTEGER.test(minute) && INTEGER.test(hour))) {
    return null;
  }
  const at = `at ${Number(hour)}:${pad(Number(minute))}`;
  if (day !== "*") {
    if (!INTEGER.test(day) || weekday !== "*") {
      return null;
    }
    if (month === "*") {
      return `Monthly on day ${Number(day)} ${at}`;
    }
    return INTEGER.test(month)
      ? `Every ${MONTHS[Number(month) - 1]} ${Number(day)} ${at}`
      : null;
  }
  if (month !== "*") {
    return null;
  }
  if (weekday === "*") {
    return `Every day ${at}`;
  }
  const days = [...parsed.weekday].sort((a, b) => a - b);
  if (days.join(",") === "1,2,3,4,5") {
    return `Every weekday ${at}`;
  }
  if (days.join(",") === "0,6") {
    return `Every weekend ${at}`;
  }
  return `Every ${joinDays(days.map((d) => WEEKDAYS[d] ?? ""))} ${at}`;
};

/**
 * Two arguments describe local wall time. The caller may supply the workspace
 * timezone to label a differing zone; cron words never convert the wall time.
 * Unsupported or malformed cron text is returned verbatim.
 */
export const cronToWords = (
  cron: string,
  timezone: string,
  workspaceTimezone = timezone
): string => {
  try {
    const words = describe(cron);
    if (words === null) {
      return cron;
    }
    const zoneName =
      timezone.split("/").at(-1)?.replaceAll("_", " ") ?? timezone;
    return timezone === workspaceTimezone
      ? words
      : `${words} (${zoneName} time)`;
  } catch {
    return cron;
  }
};
