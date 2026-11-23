import { expect, test } from "bun:test";
import {
  cutForSlack,
  OUTBOUND_TEXT_MAX,
  speakerLine,
  toSlackMrkdwn,
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

test("toSlackMrkdwn turns markdown into mrkdwn", () => {
  expect(toSlackMrkdwn("**bold** and *it* and ~~gone~~")).toBe(
    "*bold* and _it_ and ~gone~"
  );
  expect(toSlackMrkdwn("# Title\n- one\n* two")).toBe("*Title*\n• one\n• two");
  expect(toSlackMrkdwn("[docs](https://x.io/a?b=1&c=2)")).toBe(
    "<https://x.io/a?b=1&amp;c=2|docs>"
  );
});

test("toSlackMrkdwn escapes angle brackets and ampersands, keeping quotes", () => {
  expect(toSlackMrkdwn("a < b & c\n> quoted")).toBe(
    "a &lt; b &amp; c\n> quoted"
  );
});

test("toSlackMrkdwn leaves code spans as written apart from escaping", () => {
  expect(toSlackMrkdwn("`**x** <y>` and **z**")).toBe(
    "`**x** &lt;y&gt;` and *z*"
  );
  expect(toSlackMrkdwn("```\n**x**\n```")).toBe("```\n**x**\n```");
});

test("speakerLine escapes control syntax in the name, and a cut never leaves a token open", () => {
  expect(speakerLine("<!channel>", "hi")).toBe("*&lt;!channel&gt;:* hi");
  const cut = cutForSlack(
    `${"a".repeat(OUTBOUND_TEXT_MAX - 5)} <https://x.io|label>`
  );
  expect(cut.endsWith("…")).toBe(true);
  expect(cut.includes("<")).toBe(false);
});
