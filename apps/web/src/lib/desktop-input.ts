export type DesktopMouseButton = "left" | "middle" | "right";

/** One input step; coordinates are desktop pixels on the fixed 1280x800 screen. */
export type DesktopAction =
  | { type: "mouse_move"; x: number; y: number }
  | { type: "mouse_down"; button: DesktopMouseButton }
  | { type: "mouse_up"; button: DesktopMouseButton }
  | { type: "scroll"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; keys: string }
  | { type: "type"; text: string };

/** The remote desktop is always this size; every coordinate sent is a pixel on it. */
export const DESKTOP_SCREEN: {
  readonly width: number;
  readonly height: number;
} = { height: 800, width: 1280 };

// Mirrors the server's input limits so a batch is never refused for its shape.
const MAX_ACTIONS_PER_BATCH = 64;
const MAX_SCROLL_CLICKS_PER_BATCH = 60;
const MAX_SCROLL_CLICKS_PER_ACTION = 50;
const MAX_TYPE_CHARS = 512;
const MAX_KEYS_CHARS = 64;
const KEYS_PATTERN = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/;

/** Marks the element that takes desktop keyboard input, so page-level shortcuts leave its keys alone. */
export const DESKTOP_KEYBOARD_ATTRIBUTE = "data-desktop-keyboard";

export function isDesktopKeyboardTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(`[${DESKTOP_KEYBOARD_ATTRIBUTE}]`) !== null
  );
}

function clamp({ value, max }: { value: number; max: number }): number {
  return Math.min(max, Math.max(0, value));
}

interface Rect {
  height: number;
  left: number;
  top: number;
  width: number;
}

/** Where a frame drawn with `object-fit: contain` actually sits inside its box. */
export function containedFrameRect(box: Rect): Rect {
  const ratio = DESKTOP_SCREEN.width / DESKTOP_SCREEN.height;
  if (box.height <= 0 || box.width <= 0) {
    return box;
  }
  if (box.width / box.height > ratio) {
    const width = box.height * ratio;
    return {
      height: box.height,
      left: box.left + (box.width - width) / 2,
      top: box.top,
      width,
    };
  }
  const height = box.width / ratio;
  return {
    height,
    left: box.left,
    top: box.top + (box.height - height) / 2,
    width: box.width,
  };
}

/** Maps a pointer position over the frame's box to a desktop pixel, allowing for letterboxing. */
export function toDesktopPoint({
  clientX,
  clientY,
  box,
}: {
  clientX: number;
  clientY: number;
  box: Rect;
}): {
  x: number;
  y: number;
} {
  const rect = containedFrameRect(box);
  if (rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0 };
  }
  return {
    x: clamp({
      max: DESKTOP_SCREEN.width - 1,
      value: Math.floor(
        ((clientX - rect.left) / rect.width) * DESKTOP_SCREEN.width
      ),
    }),
    y: clamp({
      max: DESKTOP_SCREEN.height - 1,
      value: Math.floor(
        ((clientY - rect.top) / rect.height) * DESKTOP_SCREEN.height
      ),
    }),
  };
}

/** DOM `MouseEvent.button` to the desktop's button; the back and forward buttons have no match. */
export function toDesktopButton(button: number): DesktopMouseButton | null {
  switch (button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return null;
  }
}

/** DOM `KeyboardEvent.key` values that type nothing, as X keysym names. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  Backspace: "BackSpace",
  ContextMenu: "Menu",
  Delete: "Delete",
  End: "End",
  Enter: "Return",
  Escape: "Escape",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
  Home: "Home",
  Insert: "Insert",
  PageDown: "Page_Down",
  PageUp: "Page_Up",
  Pause: "Pause",
  PrintScreen: "Print",
  Tab: "Tab",
};

/** Printable characters that need a keysym name inside a chord. */
const SYMBOL_KEYSYMS: Readonly<Record<string, string>> = {
  " ": "space",
  "-": "minus",
  ",": "comma",
  ";": "semicolon",
  ".": "period",
  "'": "apostrophe",
  "[": "bracketleft",
  "]": "bracketright",
  "/": "slash",
  "\\": "backslash",
  "`": "grave",
  "=": "equal",
};

/** `KeyboardEvent.code` of the same keys, for chords where shift changed `key` (ctrl+shift+-). */
const CODE_KEYSYMS: Readonly<Record<string, string>> = {
  Backquote: "grave",
  Backslash: "backslash",
  BracketLeft: "bracketleft",
  BracketRight: "bracketright",
  Comma: "comma",
  Equal: "equal",
  Minus: "minus",
  Period: "period",
  Quote: "apostrophe",
  Semicolon: "semicolon",
  Slash: "slash",
  Space: "space",
};

const MODIFIER_KEYS = new Set([
  "Control",
  "Alt",
  "Shift",
  "Meta",
  "AltGraph",
  "OS",
  "Super",
  "Hyper",
  "CapsLock",
]);

export interface DesktopKeyEvent {
  /** AltGr on layouts that type characters with it; the input event carries those. */
  altGraph: boolean;
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  isComposing: boolean;
  key: string;
  /** A Mac keyboard: Cmd stands for Ctrl on the Linux desktop, and Option composes characters. */
  mac: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** Cmd chords a Mac user means as the Ctrl chords the Linux desktop knows. */
const MAC_COMMAND_KEYS = new Set(["c", "x", "v", "a", "z", "l"]);

const APPLE_PLATFORM_PATTERN = /Mac|iPhone|iPad|iPod/;
const ALPHANUMERIC_PATTERN = /^[A-Za-z0-9]$/;
const KEY_LETTER_PATTERN = /^Key([A-Z])$/;
const KEY_DIGIT_PATTERN = /^Digit([0-9])$/;

export function isMacPlatform(): boolean {
  return (
    typeof navigator !== "undefined" &&
    APPLE_PLATFORM_PATTERN.test(navigator.platform || navigator.userAgent)
  );
}

/** Ctrl+Alt+Shift gives the keyboard back to the page; it types nothing on the desktop. */
export function isReleaseChord(
  event: Pick<DesktopKeyEvent, "key" | "ctrlKey" | "altKey" | "shiftKey">
): boolean {
  return (
    event.ctrlKey &&
    event.altKey &&
    event.shiftKey &&
    (event.key === "Control" || event.key === "Alt" || event.key === "Shift")
  );
}

function chordBase(event: DesktopKeyEvent): string | null {
  if (ALPHANUMERIC_PATTERN.test(event.key)) {
    return event.key.toLowerCase();
  }
  const symbol = SYMBOL_KEYSYMS[event.key];
  if (symbol !== undefined) {
    return symbol;
  }
  const letter = KEY_LETTER_PATTERN.exec(event.code)?.[1];
  if (letter !== undefined) {
    return letter.toLowerCase();
  }
  const digit = KEY_DIGIT_PATTERN.exec(event.code)?.[1];
  if (digit !== undefined) {
    return digit;
  }
  return CODE_KEYSYMS[event.code] ?? null;
}

/**
 * The xdotool chord a keydown should send, or null when it types text (the input event sends
 * that, so layouts and dead keys work) or maps to nothing the desktop understands.
 */
export function keydownToKeys(event: DesktopKeyEvent): string | null {
  if (
    event.isComposing ||
    event.key === "Dead" ||
    event.key === "Process" ||
    MODIFIER_KEYS.has(event.key)
  ) {
    return null;
  }
  const named = NAMED_KEYS[event.key];
  // Option+letter on a Mac is a character (ø, é via a dead key), so the input event carries it.
  const altChord = event.altKey && !event.altGraph && !event.mac;
  const chorded = event.ctrlKey || event.metaKey || altChord;
  let base: string | null;
  if (named !== undefined) {
    base = named;
  } else if (chorded && !event.altGraph) {
    base = chordBase(event);
  } else {
    return null;
  }
  if (base === null) {
    return null;
  }
  const macCommand = event.mac && event.metaKey && MAC_COMMAND_KEYS.has(base);
  const modifiers = [
    (event.ctrlKey && !event.altGraph) || macCommand ? "ctrl" : undefined,
    event.altKey && !event.altGraph ? "alt" : undefined,
    event.shiftKey ? "shift" : undefined,
    event.metaKey && !macCommand ? "super" : undefined,
  ].filter((modifier): modifier is string => modifier !== undefined);
  const keys = [...modifiers, base].join("+");
  return isSendableKeys(keys) ? keys : null;
}

/** Ctrl+V, Cmd+V and Shift+Insert: left to the browser so its paste event can carry the local clipboard. */
export function isPasteChord(
  event: Pick<
    DesktopKeyEvent,
    "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
  >
): boolean {
  const isV = event.key === "v" || event.key === "V" || event.code === "KeyV";
  if (isV && (event.ctrlKey || event.metaKey) && !event.altKey) {
    return true;
  }
  return (
    event.key === "Insert" && event.shiftKey && !event.ctrlKey && !event.metaKey
  );
}

export function isSendableKeys(keys: string): boolean {
  return (
    keys.length > 0 && keys.length <= MAX_KEYS_CHARS && KEYS_PATTERN.test(keys)
  );
}

/** Text to type, split so no action exceeds the per-action limit. */
export function typeActions(text: string): DesktopAction[] {
  const actions: DesktopAction[] = [];
  const characters = Array.from(text);
  for (let start = 0; start < characters.length; start += MAX_TYPE_CHARS) {
    actions.push({
      text: characters.slice(start, start + MAX_TYPE_CHARS).join(""),
      type: "type",
    });
  }
  return actions;
}

/** Wheel deltas carried between events so slow trackpad scrolls still add up to clicks. */
export interface WheelRemainder {
  dx: number;
  dy: number;
}

const PIXELS_PER_CLICK = 100;
const LINES_PER_CLICK = 3;

/** How many pixels, lines or pages make one wheel click. */
function wheelUnitSize(deltaMode: number): number {
  if (deltaMode === 1) {
    return LINES_PER_CLICK;
  }
  if (deltaMode === 2) {
    return 1 / 3;
  }
  return PIXELS_PER_CLICK;
}

/** Converts a wheel event to whole wheel clicks, keeping the fraction for the next event. */
export function wheelToClicks({
  deltaX,
  deltaY,
  deltaMode,
  remainder,
}: {
  deltaX: number;
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
  remainder: WheelRemainder;
}): { dx: number; dy: number; remainder: WheelRemainder } {
  const perClick = wheelUnitSize(deltaMode);
  const totalX = remainder.dx + deltaX / perClick;
  const totalY = remainder.dy + deltaY / perClick;
  const dx = Math.trunc(totalX);
  const dy = Math.trunc(totalY);
  const bound = (value: number) =>
    Math.max(
      -MAX_SCROLL_CLICKS_PER_ACTION,
      Math.min(MAX_SCROLL_CLICKS_PER_ACTION, value)
    );
  return {
    dx: bound(dx),
    dy: bound(dy),
    remainder: { dx: totalX - dx, dy: totalY - dy },
  };
}

function scrollClicks(action: DesktopAction): number {
  return action.type === "scroll"
    ? Math.abs(action.dx) + Math.abs(action.dy)
    : 0;
}

/** `value` moved toward zero until its size is at most `limit`. */
function capMagnitude({
  value,
  limit,
}: {
  value: number;
  limit: number;
}): number {
  const size = Math.min(Math.abs(value), limit);
  return value < 0 && size > 0 ? -size : size;
}

/** One scroll split into steps that each fit a batch's wheel-click budget, at the same point. */
function splitScroll(action: DesktopAction): DesktopAction[] {
  if (
    action.type !== "scroll" ||
    scrollClicks(action) <= MAX_SCROLL_CLICKS_PER_BATCH
  ) {
    return [action];
  }
  const steps: DesktopAction[] = [];
  let { dx, dy } = action;
  while (dx !== 0 || dy !== 0) {
    const stepY = capMagnitude({
      limit: MAX_SCROLL_CLICKS_PER_ACTION,
      value: dy,
    });
    const stepX = capMagnitude({
      limit: Math.min(
        MAX_SCROLL_CLICKS_PER_ACTION,
        MAX_SCROLL_CLICKS_PER_BATCH - Math.abs(stepY)
      ),
      value: dx,
    });
    steps.push({ ...action, dx: stepX, dy: stepY });
    dx -= stepX;
    dy -= stepY;
  }
  return steps;
}

/** Merges what can be merged: runs of pointer moves keep the last, adjacent typing joins up. */
function coalesce(actions: readonly DesktopAction[]): DesktopAction[] {
  const merged: DesktopAction[] = [];
  for (const action of actions) {
    const previous = merged.at(-1);
    if (previous?.type === "mouse_move" && action.type === "mouse_move") {
      merged[merged.length - 1] = action;
    } else if (
      previous?.type === "type" &&
      action.type === "type" &&
      Array.from(previous.text).length + Array.from(action.text).length <=
        MAX_TYPE_CHARS
    ) {
      merged[merged.length - 1] = {
        text: previous.text + action.text,
        type: "type",
      };
    } else {
      merged.push(action);
    }
  }
  return merged;
}

/**
 * Packs queued actions into batches the server accepts: at most 64 actions and 60 wheel clicks
 * each, in the order they happened. A scroll bigger than one batch's budget is split.
 */
export function packActions(
  actions: readonly DesktopAction[]
): DesktopAction[][] {
  const batches: DesktopAction[][] = [];
  let current: DesktopAction[] = [];
  let clicks = 0;
  for (const action of coalesce(actions).flatMap(splitScroll)) {
    const actionClicks = scrollClicks(action);
    if (
      current.length > 0 &&
      (current.length >= MAX_ACTIONS_PER_BATCH ||
        clicks + actionClicks > MAX_SCROLL_CLICKS_PER_BATCH)
    ) {
      batches.push(current);
      current = [];
      clicks = 0;
    }
    current.push(action);
    clicks += actionClicks;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}
