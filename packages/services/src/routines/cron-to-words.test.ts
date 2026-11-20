import { expect, test } from "bun:test";
import { cronToWords } from "./cron-to-words.ts";

const patterns = [
  ["* * * * *", "Every minute"],
  ["*/5 * * * *", "Every 5 minutes"],
  ["0 * * * *", "Every hour at :00"],
  ["15 * * * *", "Every hour at :15"],
  ["0 9 * * *", "Every day at 9:00"],
  ["30 0 * * *", "Every day at 0:30"],
  ["0 9 * * 1-5", "Every weekday at 9:00"],
  ["0 9 * * 0,6", "Every weekend at 9:00"],
  ["0 9 * * 2", "Every Tuesday at 9:00"],
  ["0 9 * * 1,3,5", "Every Monday, Wednesday and Friday at 9:00"],
  ["0 9 1 * *", "Monthly on day 1 at 9:00"],
  ["0 9 15 * *", "Monthly on day 15 at 9:00"],
  ["0 9 25 12 *", "Every December 25 at 9:00"],
  ["0 9,17 * * *", "0 9,17 * * *"],
  ["invalid", "invalid"],
  ["99 9 * * *", "99 9 * * *"],
] as const;
for (const [cron, words] of patterns) {
  test(`cron words: ${cron}`, () => {
    expect(cronToWords(cron, "Australia/Sydney")).toBe(words);
  });
}

test("labels only a timezone different from the workspace", () => {
  expect(cronToWords("0 9 * * 2", "Australia/Sydney", "UTC")).toBe(
    "Every Tuesday at 9:00 (Sydney time)"
  );
  expect(cronToWords("0 9 * * 2", "America/New_York", "UTC")).toBe(
    "Every Tuesday at 9:00 (New York time)"
  );
  expect(cronToWords("0 9 * * 2", "UTC", "UTC")).toBe("Every Tuesday at 9:00");
  expect(cronToWords("broken", "Invalid/Zone", "UTC")).toBe("broken");
});
