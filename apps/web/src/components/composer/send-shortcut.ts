import type { KeyboardEvent } from "react";

export interface SendShortcutEvent {
  ctrlKey: boolean;
  isComposing: boolean;
  key: string;
  metaKey: boolean;
}

/** True for Ctrl+Enter or Cmd+Enter, outside an IME composition. Plain Enter and Shift+Enter are not sends. */
export const isSendShortcut = (event: SendShortcutEvent): boolean =>
  event.key === "Enter" &&
  (event.ctrlKey || event.metaKey) &&
  !event.isComposing;

const APPLE_PLATFORM = /Macintosh|Mac OS X|iPhone|iPad|iPod/i;

/** True for user agents that report a Mac or iOS platform. */
export const isMacPlatform = (userAgent: string): boolean =>
  APPLE_PLATFORM.test(userAgent);

export const sendShortcutLabel = (mac: boolean): string =>
  mac ? "⌘+Enter to send" : "Ctrl+Enter to send";

/** The keys the indicator on a button shows. */
export const submitKeysLabel = (mac: boolean): string =>
  mac ? "⌘ ↵" : "Ctrl ↵";

const takeSendShortcut = (
  event: KeyboardEvent<HTMLTextAreaElement>
): boolean => {
  if (
    !isSendShortcut({
      ctrlKey: event.ctrlKey,
      isComposing: event.nativeEvent.isComposing,
      key: event.key,
      metaKey: event.metaKey,
    })
  ) {
    return false;
  }
  event.preventDefault();
  return true;
};

/**
 * Submits the form that contains a textarea on the send shortcut. Other keys
 * keep their default. `requestSubmit` ignores a disabled submit button, so the
 * form's submit handler has to check its own pending state.
 */
export const submitOnSendShortcut = (
  event: KeyboardEvent<HTMLTextAreaElement>
): void => {
  if (takeSendShortcut(event)) {
    event.currentTarget.form?.requestSubmit();
  }
};

/** The same shortcut for a textarea with no form. It calls `action` only while `enabled`. */
export const runOnSendShortcut =
  (enabled: boolean, action: () => void) =>
  (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (takeSendShortcut(event) && enabled) {
      action();
    }
  };

/** The hint for a touch screen, where there is no Ctrl or Cmd key. */
export const TOUCH_SEND_LABEL = "Tap Send to send";
