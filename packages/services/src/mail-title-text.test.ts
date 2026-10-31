import { expect, test } from "bun:test";
import { runTitleText } from "./mail-title-text.ts";
import { buildPeerEnvelope } from "./speaker-envelope.ts";

test("a run a peer started is titled by what the peer said, not the envelope", () => {
  const envelope = buildPeerEnvelope(
    { agentName: "Hermes", connectionId: "con_1", host: "hermes.example" },
    "Summarise the deploy.\nThen list the open bugs."
  );

  expect(runTitleText(envelope)).toBe("Summarise the deploy.");
});

test("text that only looks like an envelope stays as it is", () => {
  const looksLike = '{"harbourmaster_turn": "not an envelope"}';

  expect(runTitleText(looksLike)).toBe(looksLike);
  expect(runTitleText('{"harbourmaster_turn":{"text":')).toBe(
    '{"harbourmaster_turn":{"text":'
  );
});

test("mail and plain titles are unchanged", () => {
  expect(runTitleText("Inbound mail. From a@b.c")).toBe("Inbound mail");
  expect(runTitleText("Write the report")).toBe("Write the report");
  expect(runTitleText("anything", "Re: Quarterly numbers")).toBe(
    "Quarterly numbers"
  );
});
