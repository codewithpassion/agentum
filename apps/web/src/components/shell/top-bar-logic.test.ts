import { expect, test } from "bun:test";
import {
  findShortcut,
  NEW_AGENT_HREF,
  topBarCurrent,
  topBarLinks,
  topBarTargetsMissingFromFind,
} from "./top-bar-logic.ts";

test("Spend is hidden until its page exists", () => {
  expect(topBarLinks(false).map((link) => link.label)).toEqual([
    "Home",
    "Files",
  ]);
  expect(topBarLinks(true).map((link) => link.label)).toEqual([
    "Home",
    "Files",
    "Spend",
  ]);
});

test("the current link follows the path", () => {
  for (const [pathname, current] of [
    ["/home", "Home"],
    ["/library", "Files"],
    ["/library/folder", "Files"],
    ["/spend", "Spend"],
    ["/spend/agents", "Spend"],
    ["/desk", null],
    ["/library-other", null],
    ["/homes", null],
  ] as const) {
    expect(topBarCurrent(pathname)).toBe(current);
  }
});

test("every top bar page that exists is also in Find", () => {
  expect(topBarTargetsMissingFromFind()).toEqual([]);
  expect(NEW_AGENT_HREF).toBe("/agents/new");
});

test("the Find shortcut follows the platform", () => {
  expect(findShortcut("MacIntel")).toBe("⌘K");
  expect(findShortcut("Win32")).toBe("Ctrl K");
  expect(findShortcut("Linux x86_64")).toBe("Ctrl K");
});
