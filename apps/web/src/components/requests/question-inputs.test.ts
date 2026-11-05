import { expect, test } from "bun:test";
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

test("task request settlements show hand-back time and edit cancellation", async () => {
  const { taskSettlement } = await import("./request-card-logic.ts");
  expect(
    taskSettlement(
      "takeover",
      { answer: {}, answeredBy: "u", status: "answered", via: "web" },
      "2026-11-05T22:03:00Z",
      false,
      "Handled"
    )
  ).toBe("Handed back at 22:03");
  expect(
    taskSettlement(
      "question",
      { status: "cancelled" },
      undefined,
      true,
      "Withdrawn"
    )
  ).toBe("Cancelled, you edited the message");
});
