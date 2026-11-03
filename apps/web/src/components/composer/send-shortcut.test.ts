import { expect, test } from "bun:test";
import type { KeyboardEvent } from "react";
import {
  isMacPlatform,
  isSendShortcut,
  runOnSendShortcut,
  sendShortcutLabel,
  submitKeysLabel,
  submitOnSendShortcut,
} from "./send-shortcut.ts";

const key = (overrides: Partial<Parameters<typeof isSendShortcut>[0]>) => ({
  ctrlKey: false,
  isComposing: false,
  key: "Enter",
  metaKey: false,
  ...overrides,
});

test("Ctrl+Enter sends", () => {
  expect(isSendShortcut(key({ ctrlKey: true }))).toBe(true);
});

test("Cmd+Enter sends", () => {
  expect(isSendShortcut(key({ metaKey: true }))).toBe(true);
});

test("plain Enter does not send", () => {
  expect(isSendShortcut(key({}))).toBe(false);
});

test("Shift+Enter does not send", () => {
  // The event shape has no shift flag, so Shift+Enter arrives as plain Enter.
  expect(isSendShortcut(key({ key: "Enter" }))).toBe(false);
});

test("Ctrl+Enter during an IME composition does not send", () => {
  expect(isSendShortcut(key({ ctrlKey: true, isComposing: true }))).toBe(false);
});

test("Ctrl with another key does not send", () => {
  expect(isSendShortcut(key({ ctrlKey: true, key: "s" }))).toBe(false);
});

test("isMacPlatform is true for macOS Safari and Chrome and for iPhone", () => {
  expect(
    isMacPlatform(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"
    )
  ).toBe(true);
  expect(
    isMacPlatform(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    )
  ).toBe(true);
  expect(
    isMacPlatform(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15"
    )
  ).toBe(true);
});

test("isMacPlatform is false for Windows and Linux", () => {
  expect(
    isMacPlatform(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    )
  ).toBe(false);
  expect(
    isMacPlatform(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    )
  ).toBe(false);
});

test("sendShortcutLabel names Cmd on Mac and Ctrl elsewhere", () => {
  expect(sendShortcutLabel(true)).toBe("⌘+Enter to send");
  expect(sendShortcutLabel(false)).toBe("Ctrl+Enter to send");
});

interface Stub {
  ctrlKey: boolean;
  currentTarget: { form: { requestSubmit: () => void } | null };
  key: string;
  metaKey: boolean;
  nativeEvent: { isComposing: boolean };
  preventDefault: () => void;
}

const stubEvent = (overrides: Partial<Stub> = {}) => {
  const calls = { preventDefault: 0, requestSubmit: 0 };
  const event: Stub = {
    ctrlKey: false,
    currentTarget: {
      form: {
        requestSubmit: () => {
          calls.requestSubmit += 1;
        },
      },
    },
    key: "Enter",
    metaKey: false,
    nativeEvent: { isComposing: false },
    preventDefault: () => {
      calls.preventDefault += 1;
    },
    ...overrides,
  };
  return {
    calls,
    event: event as unknown as KeyboardEvent<HTMLTextAreaElement>,
  };
};

test("submitOnSendShortcut prevents the newline and submits the form on Ctrl+Enter", () => {
  const { event, calls } = stubEvent({ ctrlKey: true });
  submitOnSendShortcut(event);
  expect(calls).toEqual({ preventDefault: 1, requestSubmit: 1 });
});

test("submitOnSendShortcut does nothing on plain Enter", () => {
  const { event, calls } = stubEvent({});
  submitOnSendShortcut(event);
  expect(calls).toEqual({ preventDefault: 0, requestSubmit: 0 });
});

test("submitKeysLabel names Cmd on Mac and Ctrl elsewhere", () => {
  expect(submitKeysLabel(true)).toBe("⌘ ↵");
  expect(submitKeysLabel(false)).toBe("Ctrl ↵");
});

test("runOnSendShortcut runs the action on Ctrl+Enter, only while enabled", () => {
  let ran = 0;
  const action = () => {
    ran += 1;
  };
  runOnSendShortcut(true, action)(stubEvent({ ctrlKey: true }).event);
  expect(ran).toBe(1);
  const disabled = stubEvent({ ctrlKey: true });
  runOnSendShortcut(false, action)(disabled.event);
  expect(ran).toBe(1);
  // A disabled button still swallows the newline the shortcut would type.
  expect(disabled.calls.preventDefault).toBe(1);
  runOnSendShortcut(true, action)(stubEvent({}).event);
  expect(ran).toBe(1);
});
