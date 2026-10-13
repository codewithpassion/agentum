import { describe, expect, test } from "bun:test";
import {
  NEW_SESSION_BADGE_MS,
  newSessionBadge,
  parseClearCommand,
  visibleFromLatestDivider,
} from "./session-divider";

const msg = (id: string, origin = "native", createdAt = 0) => ({
  createdAt,
  id,
  origin,
});
const DIVIDER = "session_start";
const idsOf = (list: { id: string }[]) => list.map((entry) => entry.id);

describe("visibleFromLatestDivider", () => {
  test("shows everything when there is no divider", () => {
    const messages = [msg("a"), msg("b")];
    expect(visibleFromLatestDivider(messages, false)).toEqual({
      hiddenCount: 0,
      visible: messages,
    });
  });

  test("starts at the latest divider and counts what it hides", () => {
    const messages = [
      msg("a"),
      msg("d1", DIVIDER),
      msg("b"),
      msg("d2", DIVIDER),
      msg("c"),
    ];
    const result = visibleFromLatestDivider(messages, false);
    expect(idsOf(result.visible)).toEqual(["d2", "c"]);
    expect(result.hiddenCount).toBe(3);
  });

  test("keeps a run of dividers together", () => {
    const messages = [
      msg("a"),
      msg("d1", DIVIDER),
      msg("d2", DIVIDER),
      msg("b"),
    ];
    expect(idsOf(visibleFromLatestDivider(messages, false).visible)).toEqual([
      "d1",
      "d2",
      "b",
    ]);
  });

  test("shows it all once expanded, and when the divider is first", () => {
    const messages = [msg("a"), msg("d", DIVIDER), msg("b")];
    expect(visibleFromLatestDivider(messages, true).hiddenCount).toBe(0);
    const first = [msg("d", DIVIDER), msg("b")];
    expect(visibleFromLatestDivider(first, false).hiddenCount).toBe(0);
  });
});

describe("newSessionBadge", () => {
  test("is the newest divider's time inside the window, else null", () => {
    const messages = [msg("d", DIVIDER, 1000), msg("a", "native", 2000)];
    expect(newSessionBadge(messages, 1000 + NEW_SESSION_BADGE_MS - 1)).toBe(
      1000
    );
    expect(newSessionBadge(messages, 1000 + NEW_SESSION_BADGE_MS)).toBeNull();
    expect(newSessionBadge([msg("a")], 0)).toBeNull();
  });
});

describe("parseClearCommand", () => {
  test("reads /clear with and without an agent", () => {
    expect(parseClearCommand("/clear")).toEqual({ agentName: null });
    expect(parseClearCommand("  /CLEAR  ")).toEqual({ agentName: null });
    expect(parseClearCommand("/clear @Ada Bot")).toEqual({
      agentName: "Ada Bot",
    });
    expect(parseClearCommand("/clear ada")).toEqual({ agentName: "ada" });
  });

  test("leaves everything else as a message", () => {
    expect(parseClearCommand("please /clear")).toBeNull();
    expect(parseClearCommand("/cleared")).toBeNull();
    expect(parseClearCommand("hello")).toBeNull();
  });
});
