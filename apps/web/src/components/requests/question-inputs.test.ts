import { expect, test } from "bun:test";
import type { Viewer } from "#/lib/time.ts";
import { pickQuestion, typeQuestion } from "./request-card-logic.ts";

test("picking clears typed text and typing clears the choice", () => {
  const q = { choices: ["A", "B"], question: "Which?" };
  const picked = pickQuestion(
    { choices: {}, text: { "Which?": "Other" } },
    q,
    "A"
  );
  expect(picked).toEqual({
    choices: { "Which?": ["A"] },
    text: { "Which?": "" },
  });
  expect(typeQuestion(picked, "Which?", "Else")).toEqual({
    choices: { "Which?": [] },
    text: { "Which?": "Else" },
  });
});

const SYDNEY: Viewer = { locale: "en-AU", timeZone: "Australia/Sydney" };
const UTC: Viewer = { locale: "en-AU", timeZone: "UTC" };

test("task request settlements show hand-back time and edit cancellation", async () => {
  const { taskSettlement } = await import("./request-card-logic.ts");
  expect(
    taskSettlement(
      "takeover",
      { answer: {}, answeredBy: "u", status: "answered", via: "web" },
      "2026-11-05T22:03:00Z",
      false,
      "Handled",
      SYDNEY
    )
  ).toBe("Handed back at 9:03 am");
  expect(
    taskSettlement(
      "question",
      { status: "cancelled" },
      undefined,
      true,
      "Withdrawn",
      SYDNEY
    )
  ).toBe("Cancelled, you edited the message");
});

test("task settlement times follow the viewer's zone, not UTC", async () => {
  const { taskSettlement } = await import("./request-card-logic.ts");
  const answered = {
    answer: {},
    answeredBy: "u",
    status: "answered",
    via: "web",
  } as const;
  const at = "2026-11-20T09:13:00.000Z";
  expect(
    taskSettlement("question", answered, at, false, "Handled", SYDNEY)
  ).toBe("Handled at 8:13 pm");
  expect(taskSettlement("question", answered, at, false, "Handled", UTC)).toBe(
    "Handled at 9:13 am"
  );
});
