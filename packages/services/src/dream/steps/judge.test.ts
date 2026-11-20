// Ported from the-brain/packages/db/src/dream/judge.ts behaviour: the salvage
// parse and the degrade path (null or unparseable output is "no verdict", never
// a throw). The Brain has no unit test for judge.ts, only the canary cases that
// run it, so these cases are written here.
import { expect, test } from "bun:test";
import { MEMORY_NOTE_MAX_CHARS } from "@repo/db/shared";
import {
  askJudge,
  clampConfidence,
  extractJsonCandidates,
  idsFrom,
  normalizeText,
  oneLine,
} from "./judge.ts";

test("a plain JSON object parses", async () => {
  const answer = await askJudge(() => Promise.resolve('{"a":1}'), "p", "s");
  expect(answer).toEqual({ a: 1 });
});

test("a JSON object wrapped in prose is recovered", async () => {
  const answer = await askJudge(
    () => Promise.resolve('Sure! Here you go: {"a":1} Hope that helps.'),
    "p",
    "s"
  );
  expect(answer).toEqual({ a: 1 });
});

test("null, garbage, an array and a throw all give null", async () => {
  expect(await askJudge(() => Promise.resolve(null), "p", "s")).toBeNull();
  expect(await askJudge(() => Promise.resolve("no json"), "p", "s")).toBeNull();
  expect(await askJudge(() => Promise.resolve("[1,2]"), "p", "s")).toBeNull();
  expect(
    await askJudge(() => Promise.reject(new Error("down")), "p", "s")
  ).toBeNull();
});

test("the judge gets the prompt and the system text in that order", async () => {
  const seen: string[] = [];
  await askJudge(
    (prompt, system) => {
      seen.push(prompt, system);
      return Promise.resolve(null);
    },
    "the prompt",
    "the system"
  );
  expect(seen).toEqual(["the prompt", "the system"]);
});

test("extractJsonCandidates returns the raw text, then the brace slice", () => {
  expect(extractJsonCandidates('x {"a":1} y')).toEqual([
    'x {"a":1} y',
    '{"a":1}',
  ]);
  expect(extractJsonCandidates("plain")).toEqual(["plain"]);
});

test("clampConfidence keeps 0 to 1 and turns anything else into 0", () => {
  expect(clampConfidence(0.5)).toBe(0.5);
  expect(clampConfidence(7)).toBe(1);
  expect(clampConfidence(-2)).toBe(0);
  expect(clampConfidence("high")).toBe(0);
  expect(clampConfidence(Number.NaN)).toBe(0);
});

test("oneLine collapses whitespace and refuses empty or over-long text", () => {
  expect(oneLine("  Mia  wants\n docs ")).toBe("Mia wants docs");
  expect(oneLine("   ")).toBeNull();
  expect(oneLine(42)).toBeNull();
  expect(oneLine("x".repeat(MEMORY_NOTE_MAX_CHARS))).not.toBeNull();
  expect(oneLine("x".repeat(MEMORY_NOTE_MAX_CHARS + 1))).toBeNull();
});

test("normalizeText ignores case, spacing and a closing full stop", () => {
  expect(normalizeText("Mia  wants docs.")).toBe(
    normalizeText("mia wants DOCS")
  );
  expect(normalizeText("Mia wants docs")).not.toBe(
    normalizeText("Mia wants pdfs")
  );
});

test("idsFrom keeps known ids once and drops invented ones", () => {
  const valid = new Set(["a", "b", "c"]);
  expect(idsFrom(["a", "x", "a", "b", 3], valid)).toEqual(["a", "b"]);
  expect(idsFrom("a", valid)).toEqual([]);
});
