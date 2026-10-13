import { describe, expect, test } from "bun:test";
import {
  currentSessionNotice,
  showSessionNotice,
} from "./agent-session-notice";

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe("session notice store", () => {
  test("holds the notice for its agent only", () => {
    showSessionNotice("agent-a", "Session reset.", 50);
    expect(currentSessionNotice("agent-a")).toBe("Session reset.");
    expect(currentSessionNotice("agent-b")).toBeNull();
  });

  test("a newer notice replaces the older one", () => {
    showSessionNotice("agent-c", "First.", 50);
    showSessionNotice("agent-c", "Second.", 50);
    expect(currentSessionNotice("agent-c")).toBe("Second.");
  });

  test("clears itself once its duration has passed", async () => {
    showSessionNotice("agent-d", "Brief.", 5);
    await pause(20);
    expect(currentSessionNotice("agent-d")).toBeNull();
  });
});
