import { expect, test } from "bun:test";
import {
  byAgentInputSchema,
  resumeInputSchema,
  setCapInputSchema,
  spendRangeSchema,
} from "./spend.ts";

test("a range of real days in order parses", () => {
  expect(
    spendRangeSchema.safeParse({ from: "2026-11-16", to: "2026-11-22" }).success
  ).toBe(true);
  expect(
    spendRangeSchema.safeParse({ from: "2026-11-16", to: "2026-11-16" }).success
  ).toBe(true);
});

test("days that are not real fail validation instead of throwing", () => {
  for (const day of ["2026-13-45", "2026-00-10", "2026-02-30", "yesterday"]) {
    expect(
      spendRangeSchema.safeParse({ from: day, to: "2026-11-22" }).success
    ).toBe(false);
  }
});

test("a range that ends before it starts fails, for both reads", () => {
  expect(
    spendRangeSchema.safeParse({ from: "2026-11-22", to: "2026-11-16" }).success
  ).toBe(false);
  expect(
    byAgentInputSchema.safeParse({
      agentId: "a1",
      from: "2026-11-22",
      to: "2026-11-16",
    }).success
  ).toBe(false);
});

test("a cap is a positive whole number of cents or null", () => {
  expect(
    setCapInputSchema.safeParse({ agentId: null, weeklyCapCents: null }).success
  ).toBe(true);
  expect(
    setCapInputSchema.safeParse({ agentId: "a1", weeklyCapCents: 0 }).success
  ).toBe(false);
  expect(
    setCapInputSchema.safeParse({ agentId: "a1", weeklyCapCents: 1.5 }).success
  ).toBe(false);
  expect(resumeInputSchema.safeParse({ agentId: "a1" }).success).toBe(true);
  expect(
    resumeInputSchema.safeParse({ agentId: "a1", weeklyCapCents: null }).success
  ).toBe(true);
});
