import {
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type DesktopAction,
  type DesktopMouseButton,
  isMacPlatform,
  isPasteChord,
  isReleaseChord,
  keydownToKeys,
  toDesktopButton,
  toDesktopPoint,
  typeActions,
  type WheelRemainder,
  wheelToClicks,
} from "./desktop-input.ts";

/** The desktop actions a pointer event means, with its position on the screen. */
const pointerActions = (
  event: ReactPointerEvent<HTMLElement>,
  kind: "down" | "move" | "up",
  surface: HTMLElement | null
): DesktopAction[] => {
  if (surface === null) {
    return [];
  }
  const point = toDesktopPoint({
    box: surface.getBoundingClientRect(),
    clientX: event.clientX,
    clientY: event.clientY,
  });
  const move: DesktopAction = { ...point, type: "mouse_move" };
  if (kind === "move") {
    return [move];
  }
  const button = toDesktopButton(event.button);
  if (button === null) {
    return [];
  }
  return [
    move,
    kind === "down"
      ? { button, type: "mouse_down" }
      : { button, type: "mouse_up" },
  ];
};

export interface DesktopInputOptions {
  /** True only while this person holds the lease: everything else is ignored. */
  enabled: boolean;
  onPaste: (text: string) => void;
  sendInput: (actions: DesktopAction[]) => void;
  /** The screen the pointer maps onto. */
  surface: RefObject<HTMLElement | null>;
}

/**
 * Turns the pointer, keyboard, wheel and paste events on the screen into
 * desktop input. Typed text comes from a hidden textarea (`keyboardRef`), so
 * layouts, dead keys and IME work. Returns the handlers to spread on the
 * elements and a way to let go of held buttons.
 */
export function useDesktopInput({
  enabled,
  onPaste,
  sendInput,
  surface,
}: DesktopInputOptions) {
  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const pressedRef = useRef(new Set<DesktopMouseButton>());
  const wheelRemainderRef = useRef<WheelRemainder>({ dx: 0, dy: 0 });
  const [keyboardFocused, setKeyboardFocused] = useState(false);

  /** Lets go of every button still held on the desktop, so none stays pressed there. */
  const releaseButtons = useCallback(() => {
    const pressed = [...pressedRef.current];
    pressedRef.current.clear();
    if (pressed.length > 0 && enabledRef.current) {
      sendInput(
        pressed.map((button): DesktopAction => ({ button, type: "mouse_up" }))
      );
    }
  }, [sendInput]);

  useEffect(() => {
    window.addEventListener("blur", releaseButtons);
    return () => window.removeEventListener("blur", releaseButtons);
  }, [releaseButtons]);

  useEffect(() => {
    if (!enabled) {
      pressedRef.current.clear();
    }
  }, [enabled]);

  // Native listeners: React's beforeinput carries no inputType, and wheel must not be passive.
  useEffect(() => {
    const keyboard = keyboardRef.current;
    const screen = surface.current;
    if (keyboard === null || screen === null) {
      return;
    }
    let composing = false;
    // Once a beforeinput has arrived it carries all typing, and input events only clean up.
    let beforeInputSeen = false;
    const onBeforeInput = (event: InputEvent) => {
      beforeInputSeen = true;
      if (!enabledRef.current) {
        return;
      }
      if (
        event.inputType === "insertText" ||
        event.inputType === "insertReplacementText"
      ) {
        event.preventDefault();
        if (event.data) {
          sendInput(typeActions(event.data));
        }
      } else if (
        event.inputType === "insertLineBreak" ||
        event.inputType === "insertParagraph"
      ) {
        event.preventDefault();
        sendInput([{ keys: "Return", type: "key" }]);
      }
    };
    // Composed text cannot be cancelled while it is built, so it goes when done.
    const onCompositionStart = () => {
      composing = true;
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      composing = false;
      if (enabledRef.current && event.data) {
        sendInput(typeActions(event.data));
      }
      keyboard.value = "";
    };
    const onInput = () => {
      if (composing) {
        return;
      }
      // Only a browser without beforeinput types through here.
      if (!beforeInputSeen && enabledRef.current && keyboard.value !== "") {
        sendInput(typeActions(keyboard.value));
      }
      keyboard.value = "";
    };
    const onWheel = (event: WheelEvent) => {
      if (!enabledRef.current) {
        return;
      }
      event.preventDefault();
      const clicks = wheelToClicks({
        deltaMode: event.deltaMode,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        remainder: wheelRemainderRef.current,
      });
      wheelRemainderRef.current = clicks.remainder;
      if (clicks.dx === 0 && clicks.dy === 0) {
        return;
      }
      const point = toDesktopPoint({
        box: screen.getBoundingClientRect(),
        clientX: event.clientX,
        clientY: event.clientY,
      });
      sendInput([{ ...point, dx: clicks.dx, dy: clicks.dy, type: "scroll" }]);
    };
    keyboard.addEventListener("beforeinput", onBeforeInput);
    keyboard.addEventListener("compositionstart", onCompositionStart);
    keyboard.addEventListener("compositionend", onCompositionEnd);
    keyboard.addEventListener("input", onInput);
    screen.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      keyboard.removeEventListener("beforeinput", onBeforeInput);
      keyboard.removeEventListener("compositionstart", onCompositionStart);
      keyboard.removeEventListener("compositionend", onCompositionEnd);
      keyboard.removeEventListener("input", onInput);
      screen.removeEventListener("wheel", onWheel);
    };
  }, [sendInput, surface]);

  const onKeyboardKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      const native = event.nativeEvent;
      // Ctrl+Alt+Shift gives the keyboard back to the page.
      if (isReleaseChord(native)) {
        event.preventDefault();
        event.currentTarget.blur();
        return;
      }
      // A paste is left to the browser so its paste event carries the local clipboard.
      if (!enabledRef.current || isPasteChord(native)) {
        return;
      }
      const keys = keydownToKeys({
        altGraph: native.getModifierState("AltGraph"),
        altKey: native.altKey,
        code: native.code,
        ctrlKey: native.ctrlKey,
        isComposing: native.isComposing,
        key: native.key,
        mac: isMacPlatform(),
        metaKey: native.metaKey,
        shiftKey: native.shiftKey,
      });
      if (keys === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      sendInput([{ keys, type: "key" }]);
    },
    [sendInput]
  );

  const onKeyboardPaste = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      if (!enabledRef.current) {
        return;
      }
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain");
      if (text !== "") {
        onPaste(text);
      }
    },
    [onPaste]
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabledRef.current) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      keyboardRef.current?.focus();
      const button = toDesktopButton(event.button);
      if (button !== null) {
        pressedRef.current.add(button);
      }
      sendInput(pointerActions(event, "down", surface.current));
    },
    [sendInput, surface]
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (enabledRef.current) {
        sendInput(pointerActions(event, "move", surface.current));
      }
    },
    [sendInput, surface]
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabledRef.current) {
        return;
      }
      const button = toDesktopButton(event.button);
      if (button !== null) {
        pressedRef.current.delete(button);
      }
      sendInput(pointerActions(event, "up", surface.current));
    },
    [sendInput, surface]
  );

  const onContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (enabledRef.current) {
      event.preventDefault();
    }
  }, []);

  const onKeyboardFocus = useCallback(() => setKeyboardFocused(true), []);
  const onKeyboardBlur = useCallback(() => setKeyboardFocused(false), []);

  return {
    keyboard: {
      onBlur: onKeyboardBlur,
      onFocus: onKeyboardFocus,
      onKeyDown: onKeyboardKeyDown,
      onPaste: onKeyboardPaste,
      ref: keyboardRef,
    },
    keyboardFocused,
    releaseButtons,
    surface: {
      onContextMenu,
      onLostPointerCapture: releaseButtons,
      onPointerCancel: releaseButtons,
      onPointerDown,
      onPointerMove,
      onPointerUp,
    },
  };
}
