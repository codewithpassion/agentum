import { describe, expect, test } from "bun:test";
import type { AnswerPayload } from "#/components/requests/request-card-logic.ts";
import {
  alwaysSendAnswer,
  answerRequest,
  notThisTimeAnswer,
  sendReplyAnswer,
} from "./answer.ts";

type Input = AnswerPayload & { requestId: string };

describe("answerRequest", () => {
  test("sends the answer with the request id", async () => {
    const seen: Input[] = [];
    const mutate = (input: Input) => {
      seen.push(input);
      return Promise.resolve({ sendError: null });
    };
    await answerRequest(mutate, "req-1", sendReplyAnswer());
    expect(seen).toEqual([{ decision: "allow_once", requestId: "req-1" }]);
  });

  test("returns the send error of the mutation", async () => {
    const mutate = () => Promise.resolve({ sendError: "SMTP is down" });
    expect(await answerRequest(mutate, "req-1", alwaysSendAnswer())).toEqual({
      sendError: "SMTP is down",
    });
  });

  test("treats a conflict as answered elsewhere, with no send error", async () => {
    const mutate = () => Promise.reject({ data: { code: "CONFLICT" } });
    expect(await answerRequest(mutate, "req-1", sendReplyAnswer())).toEqual({
      sendError: null,
    });
  });

  test("rethrows any other error", async () => {
    const mutate = () => Promise.reject(new Error("boom"));
    await expect(
      answerRequest(mutate, "req-1", sendReplyAnswer())
    ).rejects.toThrow("boom");
  });
});

describe("answer payloads", () => {
  test("send reply allows once", () => {
    expect(sendReplyAnswer()).toStrictEqual({ decision: "allow_once" });
  });

  test("always send allows always", () => {
    expect(alwaysSendAnswer()).toStrictEqual({ decision: "always_allow" });
  });

  test("a blank note is left out of a denial", () => {
    expect(notThisTimeAnswer("")).toStrictEqual({ decision: "deny" });
  });

  test("a note on a denial is trimmed", () => {
    expect(notThisTimeAnswer(" fix the tone ")).toStrictEqual({
      decision: "deny",
      note: "fix the tone",
    });
  });
});
