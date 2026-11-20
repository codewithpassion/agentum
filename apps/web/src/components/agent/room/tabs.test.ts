import { expect, test } from "bun:test";
import {
  DEFAULT_TAB,
  type LegacySheet,
  legacyRedirectSearch,
  mailParam,
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

test("an old ?sheet= or ?mail= link redirects to ?tab=, and other URLs stay put", () => {
  expect(legacyRedirectSearch({ sheet: "skills" })).toEqual({ tab: "knows" });
  expect(legacyRedirectSearch({ mail: "1", sheet: "tools" })).toEqual({
    mail: 1,
    tab: "keys",
  });
  expect(legacyRedirectSearch({ sheet: "tools", tab: "work" })).toEqual({
    tab: "work",
  });
  expect(legacyRedirectSearch({ mail: "1" })).toEqual({ mail: 1, tab: "keys" });
  expect(legacyRedirectSearch({ mail: "thread_1" })).toEqual({
    mail: "thread_1",
    tab: "keys",
  });
  expect(legacyRedirectSearch({})).toBeNull();
  expect(legacyRedirectSearch({ tab: "files" })).toBeNull();
  expect(legacyRedirectSearch({ mail: "1", tab: "chat" })).toBeNull();
});

test("the mail list marker goes in the URL as a plain number", () => {
  expect(mailParam("1")).toBe(1);
  expect(mailParam("thread_1")).toBe("thread_1");
  expect(mailParam(undefined)).toBeUndefined();
});
