import { expect, test } from "bun:test";
import { roomPolicySchema } from "./document-services";

test("policy parses authoritative relative ranges and supports an omitted optional attribution field", () => {
  const change = {
    end: { assoc: -1, tname: "content" },
    id: "change",
    name: "Agent",
    start: { tname: "content" },
    text: "accepted text",
  };
  expect(
    roomPolicySchema.parse({
      agentChanges: [change],
      ownBlobUrls: ["/files/owned.png"],
    }).agentChanges
  ).toEqual([change]);
  expect(roomPolicySchema.parse({ ownBlobUrls: [] }).agentChanges).toEqual([]);
  expect(
    roomPolicySchema.safeParse({
      agentChanges: [{ ...change, start: { text: "guessed words" } }],
      ownBlobUrls: [],
    }).success
  ).toBe(false);
  expect(
    roomPolicySchema.safeParse({
      agentChanges: [{ ...change, end: {} }],
      ownBlobUrls: [],
    }).success
  ).toBe(false);
});
