import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const contentPattern = /<DropdownMenuContent\b[^>]*>/;
const classNamePattern = /className="([^"]*)"/;
const whitespacePattern = /\s+/;

test("microphone picker sizes to labels within the viewport and wraps whole words", () => {
  const source = readFileSync(
    new URL("./dictation-button.tsx", import.meta.url),
    "utf8"
  );
  const content = source.match(contentPattern)?.[0] ?? "";
  const classes = content
    .match(classNamePattern)?.[1]
    ?.split(whitespacePattern);

  expect(content).toContain('align="start"');
  for (const className of [
    "w-max",
    "min-w-[min(18rem,calc(100vw-2rem))]",
    "max-w-[min(28rem,calc(100vw-2rem))]",
    "whitespace-normal",
    "break-normal",
  ]) {
    expect(classes).toContain(className);
  }
});
