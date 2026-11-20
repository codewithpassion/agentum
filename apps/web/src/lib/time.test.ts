import { expect, test } from "bun:test";
import { clockTime, dayClockTime, scheduledTime, type Viewer } from "./time.ts";

const SYDNEY: Viewer = { locale: "en-AU", timeZone: "Australia/Sydney" };
const UTC: Viewer = { locale: "en-AU", timeZone: "UTC" };
// 20 Nov 2026 09:13 UTC is 20:13 in Sydney (AEDT, UTC+11).
const MESSAGE_AT = "2026-11-20T09:13:00.000Z";

test("clockTime prints the viewer's zone, not the UTC of the ISO string", () => {
  expect(clockTime(MESSAGE_AT, SYDNEY)).toBe("8:13 pm");
  expect(clockTime(MESSAGE_AT, UTC)).toBe("9:13 am");
});

test("clockTime takes a Date or a millisecond count as well", () => {
  expect(clockTime(new Date(MESSAGE_AT), SYDNEY)).toBe("8:13 pm");
  expect(clockTime(Date.parse(MESSAGE_AT), SYDNEY)).toBe("8:13 pm");
});

test("dayClockTime moves to the next day when the viewer's zone is ahead", () => {
  expect(dayClockTime("2026-11-20T23:30:00.000Z", SYDNEY)).toBe(
    "21 Nov, 10:30 am"
  );
  expect(dayClockTime("2026-11-20T23:30:00.000Z", UTC)).toBe(
    "20 Nov, 11:30 pm"
  );
});

test("scheduledTime prints the workspace zone and names it, whatever the viewer's", () => {
  expect(scheduledTime("2026-11-20T21:00:00.000Z", "UTC", "en-AU")).toBe(
    "20 Nov, 9:00 pm UTC"
  );
  expect(
    scheduledTime("2026-11-20T21:00:00.000Z", "Australia/Sydney", "en-AU")
  ).toBe("21 Nov, 8:00 am AEDT");
});
