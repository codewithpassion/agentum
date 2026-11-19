import { expect, test } from "bun:test";
import {
  AGENT_AVATAR_COLORS,
  defaultAgentAvatar,
  NEUTRAL_AGENT_AVATAR_JSON,
} from "./shared.ts";

test("an ASCII letter becomes an upper-case glyph", () => {
  expect(defaultAgentAvatar("ada").glyph).toBe("A");
});

test("a non-ASCII first letter keeps its case", () => {
  expect(defaultAgentAvatar("élan").glyph).toBe("é");
});

test("an emoji first character stays whole", () => {
  expect(defaultAgentAvatar("🙂 smile").glyph).toBe("🙂");
});

test("an empty name gets the neutral glyph and colour", () => {
  expect(defaultAgentAvatar("")).toEqual({ color: "slate", glyph: "?" });
});

test("the neutral JSON default matches the empty-name avatar", () => {
  expect(JSON.parse(NEUTRAL_AGENT_AVATAR_JSON)).toEqual(defaultAgentAvatar(""));
});

test("the colour is one of the avatar colours and stays the same for the same name", () => {
  for (const name of ["ada", "Zed", "élan", "🙂 smile", "bob"]) {
    const avatar = defaultAgentAvatar(name);
    expect(AGENT_AVATAR_COLORS).toContain(avatar.color);
    expect(defaultAgentAvatar(name).color).toBe(avatar.color);
  }
});

const COLOUR_CASES: readonly { codePoint: number; name: string }[] = [
  { codePoint: 0x61, name: "ada" },
  { codePoint: 0x5a, name: "Zed" },
  { codePoint: 0xe9, name: "élan" },
  { codePoint: 0x1_f6_42, name: "🙂 smile" },
];

for (const { codePoint, name } of COLOUR_CASES) {
  test(`the colour of "${name}" is picked by its first code point`, () => {
    const expected = AGENT_AVATAR_COLORS[codePoint % 8];
    expect(expected).toBeDefined();
    expect(String(defaultAgentAvatar(name).color)).toBe(String(expected));
  });
}
