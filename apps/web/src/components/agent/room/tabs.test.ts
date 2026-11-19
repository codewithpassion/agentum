import { expect, test } from "bun:test";
import {
  DEFAULT_TAB,
  type LegacySheet,
  ROOM_TABS,
  type RoomTab,
  resolveTab,
  SHEET_IDS,
  TAB_LABELS,
} from "./tabs.ts";

test("the room has seven tabs and Chat opens first", () => {
  expect(ROOM_TABS).toEqual([
    "chat",
    "work",
    "files",
    "knows",
    "keys",
    "jobs",
    "settings",
  ]);
  expect(DEFAULT_TAB).toBe("chat");
  expect(ROOM_TABS.map((tab) => TAB_LABELS[tab])).toEqual([
    "Chat",
    "Work",
    "Files",
    "Knows",
    "Keys",
    "Jobs",
    "Settings",
  ]);
});

test("an empty search opens Chat", () => {
  expect(resolveTab({})).toBe("chat");
});

test("each old ?sheet= link opens the tab that holds its content", () => {
  const expected: Record<LegacySheet, RoomTab> = {
    channels: "keys",
    edit: "settings",
    handsTo: "keys",
    skills: "knows",
    startsOn: "jobs",
    tools: "keys",
  };
  for (const sheet of SHEET_IDS) {
    expect(resolveTab({ sheet })).toBe(expected[sheet]);
  }
});

test("an old ?mail= link opens Keys", () => {
  expect(resolveTab({ mail: "1" })).toBe("keys");
  expect(resolveTab({ mail: "thread_1" })).toBe("keys");
});

test("?tab= wins over the old params", () => {
  expect(resolveTab({ sheet: "tools", tab: "work" })).toBe("work");
  expect(resolveTab({ mail: "1", tab: "files" })).toBe("files");
  expect(resolveTab({ mail: "1", sheet: "skills" })).toBe("knows");
});
