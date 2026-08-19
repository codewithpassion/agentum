import { expect, test } from "bun:test";
import { stripCitationTags } from "./markdown";

test("strips cite tags and keeps the cited text", () => {
  expect(
    stripCitationTags('Before <cite index="1-2">Durable Objects</cite> after')
  ).toBe("Before Durable Objects after");
});

test("strips bare cite tags", () => {
  expect(stripCitationTags("<cite>a</cite> and <cite>b</cite>")).toBe(
    "a and b"
  );
});

test("leaves other angle-bracket text alone", () => {
  const body = "Use `<div>` and a <citation> word";
  expect(stripCitationTags(body)).toBe(body);
});
