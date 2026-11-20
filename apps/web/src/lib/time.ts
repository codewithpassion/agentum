/**
 * The one time rule for what the app prints. A thing that happened (a message,
 * a task, a log line, a card's "Done") shows in the viewer's own time zone. A
 * schedule (a job's next run) shows in the workspace time zone with the zone
 * named, because that is the zone it runs in. The roster service prints the
 * schedule, on the server (`packages/services/src/roster.ts`).
 */

/** Whose clock and language to print in. The browser's own, unless a test says otherwise. */
export interface Viewer {
  locale: string | undefined;
  timeZone: string;
}

/** What the server and the first browser paint use, so both render the same markup. */
export const SERVER_VIEWER: Viewer = { locale: "en-US", timeZone: "UTC" };

const CLOCK_OPTIONS = {
  hour: "numeric",
  minute: "2-digit",
} as const satisfies Intl.DateTimeFormatOptions;

const DAY_CLOCK_OPTIONS = {
  ...CLOCK_OPTIONS,
  day: "numeric",
  month: "short",
} as const satisfies Intl.DateTimeFormatOptions;

const toMs = (at: string | number | Date): number =>
  at instanceof Date ? at.getTime() : new Date(at).getTime();

/** The time of day something happened, in the viewer's zone, such as "9:13 pm". */
export const clockTime = (at: string | number | Date, viewer: Viewer): string =>
  new Intl.DateTimeFormat(viewer.locale, {
    ...CLOCK_OPTIONS,
    timeZone: viewer.timeZone,
  }).format(toMs(at));

/** The day and time something happened, in the viewer's zone, such as "20 Nov, 9:13 pm". */
export const dayClockTime = (
  at: string | number | Date,
  viewer: Viewer
): string =>
  new Intl.DateTimeFormat(viewer.locale, {
    ...DAY_CLOCK_OPTIONS,
    timeZone: viewer.timeZone,
  }).format(toMs(at));
