import { expect, test } from "bun:test";
import { StaleAncestryError } from "@repo/live-deck/migrations";
import { DECK_STALE_ANCESTRY } from "@repo/protocol/deck";
import { rejectionMessage } from "./room-rejection";

test("an update built on compacted ancestry is refused with the typed reason", () => {
  expect(rejectionMessage(new StaleAncestryError())).toBe(DECK_STALE_ANCESTRY);
});

test("other refusals keep their generic message", () => {
  expect(rejectionMessage(new Error("invalid_deck_position_migration"))).toBe(
    "Rejected message"
  );
  expect(rejectionMessage(new Error("/update: update size limit"))).toBe(
    "/update: update size limit"
  );
});
