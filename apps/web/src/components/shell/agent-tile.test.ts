import { expect, test } from "bun:test";
import { agentInitials, agentTileColour } from "./agent-tile.ts";

test("initials come from the first two words", () => {
  expect(agentInitials("Release helper")).toBe("RH");
  expect(agentInitials("scout")).toBe("S");
  expect(agentInitials("a b c")).toBe("AB");
  expect(agentInitials("   ")).toBe("?");
});

test("the tile colour is stable per name", () => {
  expect(agentTileColour("Scout")).toBe(agentTileColour("Scout"));
});
