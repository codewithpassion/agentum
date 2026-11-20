import { expect, test } from "bun:test";
import { platformUrlMismatch } from "./port-mismatch.ts";

test("a localhost URL on another port names both origins", () => {
  const message = platformUrlMismatch(
    "http://localhost:3917",
    "http://localhost:4100"
  );
  expect(message).toContain("http://localhost:3917");
  expect(message).toContain("http://localhost:4100");
});

test("a matching localhost origin passes", () => {
  expect(
    platformUrlMismatch("http://localhost:3917/", "http://localhost:3917")
  ).toBeUndefined();
});

test("a public address is never a mismatch", () => {
  expect(
    platformUrlMismatch("https://hm.example", "http://localhost:4100")
  ).toBeUndefined();
});

test("no request origin means no check", () => {
  expect(
    platformUrlMismatch("http://localhost:3917", undefined)
  ).toBeUndefined();
});
