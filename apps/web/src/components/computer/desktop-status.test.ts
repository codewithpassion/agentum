import { describe, expect, test } from "bun:test";
import { canTakeOver, controllerLabel, notLiveText } from "./desktop-status.ts";
import type { DesktopStatus } from "./desktop-stream.ts";

const status = (over: Partial<DesktopStatus> = {}): DesktopStatus => ({
  connected: true,
  control: null,
  desktop: true,
  desktopUnavailableReason: null,
  youHaveControl: false,
  ...over,
});

describe("controllerLabel", () => {
  test("names who holds the desktop", () => {
    expect(controllerLabel(null)).toBe("Connecting…");
    expect(controllerLabel(status())).toBe("Nobody is in control");
    expect(controllerLabel(status({ youHaveControl: true }))).toBe(
      "You are in control"
    );
    expect(
      controllerLabel(
        status({ control: { expiresAt: 1, holder: { kind: "agent" } } })
      )
    ).toBe("The agent is in control");
    expect(
      controllerLabel(
        status({
          control: { expiresAt: 1, holder: { kind: "human", userId: "u" } },
        })
      )
    ).toBe("Another person is in control");
  });
});

describe("notLiveText", () => {
  const live = { connection: "open", problem: null } as const;

  test("is null while live or still connecting", () => {
    expect(notLiveText({ ...live, status: status() })).toBeNull();
    expect(
      notLiveText({ connection: "connecting", problem: null, status: null })
    ).toBeNull();
  });

  test("says the computer is offline", () => {
    expect(notLiveText({ ...live, status: status({ connected: false }) })).toBe(
      "Computer offline"
    );
    expect(
      notLiveText({ ...live, problem: { kind: "offline" }, status: null })
    ).toBe("Computer offline");
  });

  test("says the desktop is unavailable, with the reason when there is one", () => {
    expect(notLiveText({ ...live, status: status({ desktop: false }) })).toBe(
      "Desktop unavailable"
    );
    expect(
      notLiveText({
        ...live,
        status: status({
          desktop: false,
          desktopUnavailableReason: "no display",
        }),
      })
    ).toBe("Desktop unavailable: no display");
    expect(
      notLiveText({
        ...live,
        problem: { kind: "unavailable", message: "xvfb died" },
        status: status(),
      })
    ).toBe("Desktop unavailable: xvfb died");
  });

  test("explains the other problems and a dropped socket", () => {
    expect(
      notLiveText({
        ...live,
        problem: { kind: "human_in_control" },
        status: status(),
      })
    ).toContain("Another person");
    expect(
      notLiveText({
        ...live,
        problem: { kind: "failed", message: "bad reply" },
        status: status(),
      })
    ).toBe("bad reply");
    expect(
      notLiveText({
        connection: "reconnecting",
        problem: null,
        status: status(),
      })
    ).toBe("Connection lost. Reconnecting…");
  });
});

describe("canTakeOver", () => {
  test("needs a pending takeover and a free or agent-held desktop", () => {
    expect(canTakeOver({ hasTakeover: true, status: status() })).toBe(true);
    expect(canTakeOver({ hasTakeover: false, status: status() })).toBe(false);
    expect(canTakeOver({ hasTakeover: true, status: null })).toBe(false);
    expect(
      canTakeOver({
        hasTakeover: true,
        status: status({
          control: { expiresAt: 1, holder: { kind: "agent" } },
        }),
      })
    ).toBe(true);
  });

  test("refuses while another person or you hold it, or it is down", () => {
    expect(
      canTakeOver({
        hasTakeover: true,
        status: status({
          control: { expiresAt: 1, holder: { kind: "human", userId: "u" } },
        }),
      })
    ).toBe(false);
    expect(
      canTakeOver({
        hasTakeover: true,
        status: status({ youHaveControl: true }),
      })
    ).toBe(false);
    expect(
      canTakeOver({ hasTakeover: true, status: status({ connected: false }) })
    ).toBe(false);
    expect(
      canTakeOver({ hasTakeover: true, status: status({ desktop: false }) })
    ).toBe(false);
  });
});
