import { expect, test } from "bun:test";
import {
  cutForSlack,
  OUTBOUND_TEXT_MAX,
  speakerLine,
} from "./room-out-text.ts";

test("short text passes through", () => {
  expect(cutForSlack("hello")).toBe("hello");
});

test("long text is cut to the limit with an ellipsis", () => {
  const cut = cutForSlack("a".repeat(OUTBOUND_TEXT_MAX + 50));
  expect(cut.length).toBe(OUTBOUND_TEXT_MAX);
  expect(cut.endsWith("…")).toBe(true);
});

test("a cut never splits a surrogate pair", () => {
  const cut = cutForSlack("😀".repeat(OUTBOUND_TEXT_MAX));
  expect(cut.length).toBeLessThanOrEqual(OUTBOUND_TEXT_MAX);
  expect(cut.replaceAll("😀", "").replaceAll("…", "")).toBe("");
});

test("the speaker line puts the name in bold before the text", () => {
  expect(speakerLine("Ada Lovelace", "hi there")).toBe(
    "*Ada Lovelace:* hi there"
  );
});

test("the name loses markup and line breaks", () => {
  expect(speakerLine("*Ada*\n_L_", "hi")).toBe("*Ada L:* hi");
});

test("a missing or empty name falls back to Someone", () => {
  expect(speakerLine(null, "hi")).toBe("*Someone:* hi");
  expect(speakerLine("  ", "hi")).toBe("*Someone:* hi");
});

test("a long name is cut and the whole line stays within the limit", () => {
  const line = speakerLine("n".repeat(500), "x".repeat(OUTBOUND_TEXT_MAX));
  expect(line.length).toBeLessThanOrEqual(OUTBOUND_TEXT_MAX);
  expect(line.startsWith(`*${"n".repeat(80)}:* `)).toBe(true);
});
