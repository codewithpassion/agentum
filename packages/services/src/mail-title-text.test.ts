import { expect, test } from "bun:test";
import { readableTitle, runTitleText } from "./mail-title-text.ts";
import { buildPeerEnvelope } from "./speaker-envelope.ts";

test("a run a peer started is titled by what the peer said, not the envelope", () => {
  const envelope = buildPeerEnvelope(
    { agentName: "Hermes", connectionId: "con_1", host: "hermes.example" },
    "Summarise the deploy.\nThen list the open bugs."
  );

  expect(runTitleText(envelope)).toBe("Summarise the deploy.");
});

test("unreadable run inputs have a safe title", () => {
  expect(runTitleText('{"harbourmaster_turn": "not an envelope"}')).toBe(
    "Conversation"
  );
  expect(runTitleText('{"harbourmaster_turn":{"text":')).toBe("Conversation");
});

test("mail and plain titles are unchanged", () => {
  expect(runTitleText("Inbound mail. From a@b.c")).toBe("Inbound mail");
  expect(runTitleText("Write the report")).toBe("Write the report");
  expect(runTitleText("anything", "Re: Quarterly numbers")).toBe(
    "Quarterly numbers"
  );
});

test("readableTitle loosely unwraps envelopes without requiring speaker fields", () => {
  expect(
    readableTitle(
      ' {"harbourmaster_turn":{"text":"Hello there", "extra":true}}'
    )
  ).toBe("Hello there");
  expect(readableTitle('{"harbourmaster_turn":{"text":"Hi"}}')).toBe("Hi");
});

test("readableTitle strips markers and uses the first nonempty line", () => {
  expect(
    readableTitle("[ATTACHMENT:/tmp/a]\n\n  Hello   team\t today\nSecond line")
  ).toBe("Hello team today");
  expect(readableTitle("Hello [ATTACHMENT:/tmp/a] team")).toBe("Hello team");
});

test.each([
  "",
  "  \n\t",
  "[ATTACHMENT:/tmp/a]",
  "<div>Hello</div>",
  "<!-- comment -->",
  '<?xml version="1.0"?><root/>',
  '{"a":1}',
  "[1,2]",
  '{\n  "a": 1\n}',
  '{"harbourmaster_turn":',
])("readableTitle rejects unreadable input %s", (raw) => {
  expect(readableTitle(raw)).toBeUndefined();
});

test("readableTitle allows prose and caps at 80 including dots", () => {
  expect(readableTitle("[draft] hello")).toBe("[draft] hello");
  expect(readableTitle("< 3 items")).toBe("< 3 items");
  expect(readableTitle("a".repeat(80))).toBe("a".repeat(80));
  expect(readableTitle("a".repeat(81))).toBe(`${"a".repeat(77)}...`);
});

test("multiline tags do not become titles", () => {
  expect(readableTitle('<div\n class="content">Hello</div>')).toBeUndefined();
});
