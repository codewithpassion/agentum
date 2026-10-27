import { describe, expect, test } from "bun:test";

import type { DesktopAction } from "./desktop-input.ts";
import {
  containedFrameRect,
  type DesktopKeyEvent,
  isPasteChord,
  isReleaseChord,
  keydownToKeys,
  PHONE_KEYS,
  packActions,
  toDesktopButton,
  toDesktopPoint,
  typeActions,
  wheelToClicks,
} from "./desktop-input.ts";

const SENDABLE_KEYS = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/;

function key(
  overrides: Partial<DesktopKeyEvent> & Pick<DesktopKeyEvent, "key">
): DesktopKeyEvent {
  return {
    altGraph: false,
    altKey: false,
    code: "",
    ctrlKey: false,
    isComposing: false,
    mac: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("toDesktopPoint", () => {
  test("scales the displayed frame to the 1280x800 desktop", () => {
    const box = { height: 400, left: 100, top: 50, width: 640 };
    expect(toDesktopPoint({ box, clientX: 100, clientY: 50 })).toEqual({
      x: 0,
      y: 0,
    });
    expect(toDesktopPoint({ box, clientX: 420, clientY: 250 })).toEqual({
      x: 640,
      y: 400,
    });
    expect(toDesktopPoint({ box, clientX: 739.9, clientY: 449.9 })).toEqual({
      x: 1279,
      y: 799,
    });
  });

  test("clamps points outside the frame to its edge", () => {
    const box = { height: 400, left: 0, top: 0, width: 640 };
    expect(toDesktopPoint({ box, clientX: -20, clientY: 900 })).toEqual({
      x: 0,
      y: 799,
    });
    expect(toDesktopPoint({ box, clientX: 5000, clientY: -1 })).toEqual({
      x: 1279,
      y: 0,
    });
  });

  test("allows for the letterbox when the box is wider than the frame", () => {
    // 1000x400 box: the 16:10 frame is 640 wide, centred with 180 on each side.
    const box = { height: 400, left: 0, top: 0, width: 1000 };
    expect(containedFrameRect(box)).toEqual({
      height: 400,
      left: 180,
      top: 0,
      width: 640,
    });
    expect(toDesktopPoint({ box, clientX: 180, clientY: 0 })).toEqual({
      x: 0,
      y: 0,
    });
    expect(toDesktopPoint({ box, clientX: 500, clientY: 200 })).toEqual({
      x: 640,
      y: 400,
    });
  });

  test("allows for the letterbox when the box is taller than the frame", () => {
    const box = { height: 600, left: 0, top: 0, width: 640 };
    expect(containedFrameRect(box)).toEqual({
      height: 400,
      left: 0,
      top: 100,
      width: 640,
    });
    expect(toDesktopPoint({ box, clientX: 320, clientY: 300 })).toEqual({
      x: 640,
      y: 400,
    });
  });

  test("maps a full-size frame with no letterbox at its offset", () => {
    // The expanded view is sized to the exact 16:10 ratio, so the box is the frame.
    const box = { height: 1600, left: 100, top: 50, width: 2560 };
    expect(containedFrameRect(box)).toEqual(box);
    expect(toDesktopPoint({ box, clientX: 100, clientY: 50 })).toEqual({
      x: 0,
      y: 0,
    });
    expect(toDesktopPoint({ box, clientX: 1380, clientY: 850 })).toEqual({
      x: 640,
      y: 400,
    });
    expect(toDesktopPoint({ box, clientX: 2659, clientY: 1649 })).toEqual({
      x: 1279,
      y: 799,
    });
  });

  test("maps a large letterboxed frame at any size", () => {
    // 1920x1080 box: the frame is 1728 wide, centred with 96 on each side.
    const box = { height: 1080, left: 0, top: 0, width: 1920 };
    expect(containedFrameRect(box)).toEqual({
      height: 1080,
      left: 96,
      top: 0,
      width: 1728,
    });
    expect(toDesktopPoint({ box, clientX: 95, clientY: 540 })).toEqual({
      x: 0,
      y: 400,
    });
    expect(toDesktopPoint({ box, clientX: 1823, clientY: 1079 })).toEqual({
      x: 1279,
      y: 799,
    });
  });

  test("maps DOM buttons and ignores back and forward", () => {
    expect(toDesktopButton(0)).toBe("left");
    expect(toDesktopButton(1)).toBe("middle");
    expect(toDesktopButton(2)).toBe("right");
    expect(toDesktopButton(3)).toBeNull();
  });
});

describe("keydownToKeys", () => {
  test("leaves printable keys to the input event", () => {
    expect(keydownToKeys(key({ code: "KeyA", key: "a" }))).toBeNull();
    expect(
      keydownToKeys(key({ code: "KeyA", key: "A", shiftKey: true }))
    ).toBeNull();
    expect(keydownToKeys(key({ code: "Space", key: " " }))).toBeNull();
    expect(keydownToKeys(key({ code: "Digit2", key: "é" }))).toBeNull();
  });

  test("leaves dead keys, composition and lone modifiers alone", () => {
    expect(keydownToKeys(key({ code: "Quote", key: "Dead" }))).toBeNull();
    expect(
      keydownToKeys(key({ isComposing: true, key: "Process" }))
    ).toBeNull();
    expect(keydownToKeys(key({ ctrlKey: true, key: "Control" }))).toBeNull();
    expect(keydownToKeys(key({ key: "Shift", shiftKey: true }))).toBeNull();
  });

  test("names keys that type nothing with X keysyms", () => {
    expect(keydownToKeys(key({ key: "Enter" }))).toBe("Return");
    expect(keydownToKeys(key({ key: "Backspace" }))).toBe("BackSpace");
    expect(keydownToKeys(key({ key: "ArrowLeft" }))).toBe("Left");
    expect(keydownToKeys(key({ key: "PageDown" }))).toBe("Page_Down");
    expect(keydownToKeys(key({ key: "Tab", shiftKey: true }))).toBe(
      "shift+Tab"
    );
    expect(keydownToKeys(key({ key: "F5" }))).toBe("F5");
    expect(keydownToKeys(key({ key: "Escape" }))).toBe("Escape");
  });

  test("sends chords as modifier+key in xdotool form", () => {
    expect(keydownToKeys(key({ code: "KeyL", ctrlKey: true, key: "l" }))).toBe(
      "ctrl+l"
    );
    expect(
      keydownToKeys(
        key({ code: "KeyC", ctrlKey: true, key: "C", shiftKey: true })
      )
    ).toBe("ctrl+shift+c");
    expect(keydownToKeys(key({ altKey: true, key: "Tab" }))).toBe("alt+Tab");
    expect(keydownToKeys(key({ ctrlKey: true, key: "Enter" }))).toBe(
      "ctrl+Return"
    );
    expect(keydownToKeys(key({ code: "KeyD", key: "d", metaKey: true }))).toBe(
      "super+d"
    );
  });

  test("names punctuation in chords, falling back to the physical key when shift changed it", () => {
    expect(keydownToKeys(key({ code: "Minus", ctrlKey: true, key: "-" }))).toBe(
      "ctrl+minus"
    );
    expect(
      keydownToKeys(
        key({ code: "Minus", ctrlKey: true, key: "_", shiftKey: true })
      )
    ).toBe("ctrl+shift+minus");
    expect(
      keydownToKeys(
        key({ code: "Digit1", ctrlKey: true, key: "!", shiftKey: true })
      )
    ).toBe("ctrl+shift+1");
    expect(keydownToKeys(key({ code: "Space", ctrlKey: true, key: " " }))).toBe(
      "ctrl+space"
    );
  });

  test("only produces chords the server pattern accepts", () => {
    for (const keys of [
      keydownToKeys(key({ code: "Slash", ctrlKey: true, key: "/" })),
      keydownToKeys(key({ ctrlKey: true, key: "Home", shiftKey: true })),
    ]) {
      expect(keys).toMatch(SENDABLE_KEYS);
    }
    expect(
      keydownToKeys(key({ code: "IntlBackslash", ctrlKey: true, key: "§" }))
    ).toBeNull();
  });

  test("lets AltGr characters through to the input event", () => {
    expect(
      keydownToKeys(
        key({
          altGraph: true,
          altKey: true,
          code: "KeyQ",
          ctrlKey: true,
          key: "@",
        })
      )
    ).toBeNull();
  });

  test("sends Cmd+C/X/V/A/Z/L on a Mac as the Ctrl chords the Linux desktop uses", () => {
    for (const letter of ["c", "x", "v", "a", "z", "l"]) {
      expect(
        keydownToKeys(
          key({
            code: `Key${letter.toUpperCase()}`,
            key: letter,
            mac: true,
            metaKey: true,
          })
        )
      ).toBe(`ctrl+${letter}`);
    }
    expect(
      keydownToKeys(
        key({
          code: "KeyZ",
          key: "z",
          mac: true,
          metaKey: true,
          shiftKey: true,
        })
      )
    ).toBe("ctrl+shift+z");
    // Other Cmd chords stay Super chords, and off a Mac Cmd is always Super.
    expect(
      keydownToKeys(key({ code: "KeyD", key: "d", mac: true, metaKey: true }))
    ).toBe("super+d");
    expect(keydownToKeys(key({ code: "KeyC", key: "c", metaKey: true }))).toBe(
      "super+c"
    );
  });

  test("leaves Option+letter on a Mac to the input event, which carries the composed character", () => {
    expect(
      keydownToKeys(key({ altKey: true, code: "KeyO", key: "ø", mac: true }))
    ).toBeNull();
    expect(keydownToKeys(key({ altKey: true, code: "KeyO", key: "o" }))).toBe(
      "alt+o"
    );
    // Option still modifies keys that type nothing.
    expect(
      keydownToKeys(key({ altKey: true, key: "ArrowLeft", mac: true }))
    ).toBe("alt+Left");
  });

  test("recognises the release chord only once all of Ctrl, Alt and Shift are down", () => {
    expect(
      isReleaseChord(
        key({ altKey: true, ctrlKey: true, key: "Shift", shiftKey: true })
      )
    ).toBe(true);
    expect(
      isReleaseChord(
        key({ altKey: true, ctrlKey: true, key: "Control", shiftKey: true })
      )
    ).toBe(true);
    expect(
      isReleaseChord(key({ ctrlKey: true, key: "Shift", shiftKey: true }))
    ).toBe(false);
    expect(
      isReleaseChord(
        key({
          altKey: true,
          code: "KeyT",
          ctrlKey: true,
          key: "T",
          shiftKey: true,
        })
      )
    ).toBe(false);
  });

  test("recognises the paste chords", () => {
    expect(isPasteChord(key({ code: "KeyV", ctrlKey: true, key: "v" }))).toBe(
      true
    );
    expect(isPasteChord(key({ code: "KeyV", key: "v", metaKey: true }))).toBe(
      true
    );
    expect(isPasteChord(key({ key: "Insert", shiftKey: true }))).toBe(true);
    expect(isPasteChord(key({ code: "KeyV", key: "v" }))).toBe(false);
    expect(isPasteChord(key({ code: "KeyC", ctrlKey: true, key: "c" }))).toBe(
      false
    );
  });
});

describe("typeActions", () => {
  test("splits long text so no action exceeds 512 characters", () => {
    const actions = typeActions("x".repeat(1030));
    expect(
      actions.map((action) => (action.type === "type" ? action.text.length : 0))
    ).toEqual([512, 512, 6]);
  });
});

describe("wheelToClicks", () => {
  test("turns pixel deltas into clicks and carries the fraction", () => {
    const first = wheelToClicks({
      deltaMode: 0,
      deltaX: 0,
      deltaY: 150,
      remainder: { dx: 0, dy: 0 },
    });
    expect(first).toMatchObject({ dx: 0, dy: 1 });
    const second = wheelToClicks({
      deltaMode: 0,
      deltaX: 0,
      deltaY: 50,
      remainder: first.remainder,
    });
    expect(second).toMatchObject({ dx: 0, dy: 1 });
  });

  test("treats three lines as one click and scrolls up for negative deltas", () => {
    expect(
      wheelToClicks({
        deltaMode: 1,
        deltaX: 0,
        deltaY: -6,
        remainder: { dx: 0, dy: 0 },
      })
    ).toMatchObject({
      dy: -2,
    });
  });

  test("caps one action at 50 clicks", () => {
    expect(
      wheelToClicks({
        deltaMode: 0,
        deltaX: 0,
        deltaY: 100_000,
        remainder: { dx: 0, dy: 0 },
      }).dy
    ).toBe(50);
  });
});

describe("packActions", () => {
  test("keeps only the last of consecutive pointer moves and joins adjacent typing", () => {
    const actions: DesktopAction[] = [
      { type: "mouse_move", x: 1, y: 1 },
      { type: "mouse_move", x: 2, y: 2 },
      { button: "left", type: "mouse_down" },
      { text: "ab", type: "type" },
      { text: "c", type: "type" },
    ];
    expect(packActions(actions)).toEqual([
      [
        { type: "mouse_move", x: 2, y: 2 },
        { button: "left", type: "mouse_down" },
        { text: "abc", type: "type" },
      ],
    ]);
  });

  test("splits batches at 64 actions", () => {
    const actions: DesktopAction[] = Array.from({ length: 130 }, () => ({
      keys: "a",
      type: "key",
    }));
    expect(packActions(actions).map((batch) => batch.length)).toEqual([
      64, 64, 2,
    ]);
  });

  test("splits batches before they scroll more than 60 clicks", () => {
    const scroll: DesktopAction = { dx: 0, dy: 25, type: "scroll", x: 0, y: 0 };
    expect(
      packActions([scroll, scroll, scroll]).map((batch) => batch.length)
    ).toEqual([2, 1]);
  });

  test("splits one scroll bigger than the budget and never sends an empty batch", () => {
    const batches = packActions([
      { dx: -50, dy: 50, type: "scroll", x: 10, y: 20 },
    ]);
    expect(batches.every((batch) => batch.length > 0)).toBe(true);
    const steps = batches.flat();
    let dx = 0;
    let dy = 0;
    for (const step of steps) {
      if (step.type !== "scroll") {
        throw new Error("expected only scroll steps");
      }
      expect(step).toMatchObject({ x: 10, y: 20 });
      expect(Math.abs(step.dx) + Math.abs(step.dy)).toBeLessThanOrEqual(60);
      expect(Math.abs(step.dx)).toBeLessThanOrEqual(50);
      expect(Math.abs(step.dy)).toBeLessThanOrEqual(50);
      dx += step.dx;
      dy += step.dy;
    }
    expect({ dx, dy }).toEqual({ dx: -50, dy: 50 });
    for (const batch of batches) {
      const clicks = batch.reduce(
        (sum, a) =>
          sum + (a.type === "scroll" ? Math.abs(a.dx) + Math.abs(a.dy) : 0),
        0
      );
      expect(clicks).toBeLessThanOrEqual(60);
    }
  });

  test("starts a batch with an oversized scroll instead of an empty one", () => {
    const batches = packActions([
      { dx: 0, dy: 50, type: "scroll", x: 0, y: 0 },
      { dx: 30, dy: 40, type: "scroll", x: 0, y: 0 },
    ]);
    expect(batches.map((batch) => batch.length)).not.toContain(0);
    expect(batches.length).toBeGreaterThan(1);
  });
});

describe("PHONE_KEYS", () => {
  test("every button sends keys the desktop accepts", () => {
    expect(PHONE_KEYS.map((entry) => entry.keys)).toEqual([
      "Return",
      "BackSpace",
      "Escape",
      "Tab",
      "Left",
      "Up",
      "Down",
      "Right",
    ]);
    for (const entry of PHONE_KEYS) {
      expect(entry.keys).toMatch(SENDABLE_KEYS);
    }
  });
});
