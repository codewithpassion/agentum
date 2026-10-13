import {
  type ChangeEvent,
  type FormEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "#/components/ui/button";
import { TextAreaField } from "#/components/ui/field";
import { cx } from "#/lib/cx";
import {
  type ComputerDesktopServer,
  type DesktopController,
  type DesktopFrameProblem,
  type DesktopStatus,
  readDesktopFailure,
} from "#/lib/desktop-api";
import {
  DESKTOP_SCREEN,
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
} from "#/lib/desktop-input";
import { type DesktopFrame, useDesktopScreen } from "#/lib/use-desktop-screen";

/** A human lease lasts 5 minutes without input; warn in its last minute. */
const LEASE_WARNING_MS = 60_000;
/** The route's answer when the caller no longer holds the lease. */
const HTTP_LOCKED = 423;
const NOTE_MAX_CHARS = 2000;
/** Frames come about every half second; one this old means the view has stopped following. */
const STALE_FRAME_MS = 5000;
const CLOCK_TICK_MS = 1000;
const FRAME_AGE_TICK_MS = 250;

/** Chords the local browser keeps for itself, so they can only reach the desktop from here. */
const RESERVED_CHORDS: { label: string; keys: string }[] = [
  { keys: "ctrl+w", label: "Ctrl+W" },
  { keys: "ctrl+t", label: "Ctrl+T" },
  { keys: "ctrl+l", label: "Ctrl+L" },
  { keys: "super", label: "Super" },
];

export interface DesktopScreenProps {
  /** The saved agent whose desktop this is. */
  agentId: string;
  className?: string;
  /** Stops polling while the view is hidden, keeping control of the desktop. */
  paused?: boolean;
  server: ComputerDesktopServer;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function isMine(controller: DesktopController | undefined): boolean {
  return controller?.kind === "human" && controller.isMe;
}

function controllerLabel(controller: DesktopController): string {
  if (controller.kind === "none") {
    return "Nobody is in control";
  }
  if (controller.kind === "agent") {
    return "The agent is in control";
  }
  return controller.isMe
    ? "You are in control"
    : "Another person is in control";
}

/** Its own clock, so the age ticks without re-rendering the whole view. */
function FrameAge({ frame }: { frame: DesktopFrame | null }) {
  const now = useNow(FRAME_AGE_TICK_MS);
  if (frame === null) {
    return <span>No frame yet</span>;
  }
  const ageMs = Math.max(0, now - frame.receivedAt);
  const seconds = ageMs / 1000;
  const text = `Frame ${seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))} s old`;
  if (ageMs < STALE_FRAME_MS) {
    return <span data-testid="desktop-frame-age">{text}</span>;
  }
  return (
    <span className="text-[var(--ws-warn)]" data-testid="desktop-frame-age">
      {text}, not updating
    </span>
  );
}

/** Why the view is not live, or null while it is. */
function problemText({
  problem,
  status,
}: {
  problem: DesktopFrameProblem | null;
  status: DesktopStatus | null;
}): string | null {
  if (status !== null && !status.online) {
    return "The computer is offline.";
  }
  if (status !== null && !status.desktop) {
    return (
      status.desktopUnavailableReason ||
      "The computer is not running a desktop."
    );
  }
  if (problem === null) {
    return null;
  }
  if (problem.kind === "human_in_control") {
    return "Another person is controlling the desktop. The view comes back when they hand it back.";
  }
  if (problem.kind === "clearing") {
    return "Clearing the last person’s clipboard…";
  }
  if (problem.kind === "offline") {
    return "The computer is offline.";
  }
  if (problem.kind === "unavailable") {
    return problem.message || "The desktop is not available right now.";
  }
  return problem.message;
}

/** The desktop action a pointer event means, with its position on the screen. */
function pointerActions(
  event: ReactPointerEvent<HTMLDivElement>,
  action: "down" | "up" | "move",
  surface: HTMLDivElement | null
): DesktopAction[] {
  if (surface === null) {
    return [];
  }
  const point = toDesktopPoint({
    box: surface.getBoundingClientRect(),
    clientX: event.clientX,
    clientY: event.clientY,
  });
  const move: DesktopAction = { ...point, type: "mouse_move" };
  if (action === "move") {
    return [move];
  }
  const button = toDesktopButton(event.button);
  if (button === null) {
    return [];
  }
  return [
    move,
    action === "down"
      ? { button, type: "mouse_down" }
      : { button, type: "mouse_up" },
  ];
}

/**
 * The live view of an agent's desktop, with take control, hand back, and clipboard.
 * Keyboard and pointer input reach the desktop only while the viewer holds control.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one view wires the keyboard, pointer, and wheel paths to shared refs; splitting it would scatter them
export function DesktopScreen({
  server,
  agentId,
  paused = false,
  className,
}: DesktopScreenProps) {
  // The hook keys its state by computer; an agent's desktop is keyed by the agent itself.
  const screen = useDesktopScreen({
    agentId,
    computerId: agentId,
    paused,
    server,
  });
  const {
    applyStatus,
    flushInput,
    frame,
    frameProblem,
    inputError,
    pasteText,
    refreshStatus,
    sendInput,
    status,
    statusError,
  } = screen;
  const now = useNow(CLOCK_TICK_MS);

  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [sendText, setSendText] = useState("");
  const [manualCopy, setManualCopy] = useState<string | null>(null);

  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const wheelRemainderRef = useRef<WheelRemainder>({ dx: 0, dy: 0 });
  const composingRef = useRef<boolean>(false);
  // Once a beforeinput has arrived, it carries all typing and input events only clean up.
  const beforeInputSeenRef = useRef<boolean>(false);
  const pressedRef = useRef(new Set<DesktopMouseButton>());
  const [keyboardFocused, setKeyboardFocused] = useState(false);

  const controller = status?.controller;
  const inControl = isMine(controller);
  const inControlRef = useRef(inControl);
  inControlRef.current = inControl;

  /** Lets go of every button still held on the desktop, so none stays pressed there. */
  const releaseButtons = useCallback(() => {
    const pressed = [...pressedRef.current];
    pressedRef.current.clear();
    if (pressed.length === 0 || !inControlRef.current) {
      return;
    }
    sendInput(
      pressed.map((button): DesktopAction => ({ button, type: "mouse_up" }))
    );
  }, [sendInput]);

  useEffect(() => {
    window.addEventListener("blur", releaseButtons);
    return () => window.removeEventListener("blur", releaseButtons);
  }, [releaseButtons]);

  // Nothing of a control session outlives it: held buttons and clipboard text left to copy.
  useEffect(() => {
    if (inControl) {
      return;
    }
    pressedRef.current.clear();
    setManualCopy(null);
  }, [inControl]);

  // Native listeners: React's beforeinput carries no inputType, and wheel must not be passive.
  useEffect(() => {
    const keyboard = keyboardRef.current;
    const surface = frameRef.current;
    if (keyboard === null || surface === null) {
      return;
    }
    const onBeforeInput = (event: InputEvent) => {
      beforeInputSeenRef.current = true;
      if (!inControlRef.current) {
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
    // Composed text (IME, some dead keys) cannot be cancelled while it is being built, so it goes when done.
    const onCompositionStart = () => {
      composingRef.current = true;
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      composingRef.current = false;
      if (inControlRef.current && event.data) {
        sendInput(typeActions(event.data));
      }
      keyboard.value = "";
    };
    const onInput = () => {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: the composition listeners write this ref, which the checker cannot see
      if (composingRef.current) {
        return;
      }
      // Only a browser without beforeinput types through here; elsewhere that event already sent it.
      if (
        // biome-ignore lint/suspicious/noUnnecessaryConditions: the beforeinput listener writes this ref, which the checker cannot see
        !beforeInputSeenRef.current &&
        inControlRef.current &&
        keyboard.value !== ""
      ) {
        sendInput(typeActions(keyboard.value));
      }
      keyboard.value = "";
    };
    const onWheel = (event: WheelEvent) => {
      if (!inControlRef.current) {
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
        box: surface.getBoundingClientRect(),
        clientX: event.clientX,
        clientY: event.clientY,
      });
      sendInput([{ ...point, dx: clicks.dx, dy: clicks.dy, type: "scroll" }]);
    };
    keyboard.addEventListener("beforeinput", onBeforeInput);
    keyboard.addEventListener("compositionstart", onCompositionStart);
    keyboard.addEventListener("compositionend", onCompositionEnd);
    keyboard.addEventListener("input", onInput);
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      keyboard.removeEventListener("beforeinput", onBeforeInput);
      keyboard.removeEventListener("compositionstart", onCompositionStart);
      keyboard.removeEventListener("compositionend", onCompositionEnd);
      keyboard.removeEventListener("input", onInput);
      surface.removeEventListener("wheel", onWheel);
    };
  }, [sendInput]);

  const run = useCallback(
    async (task: () => Promise<void>) => {
      setBusy(true);
      setNotice(null);
      try {
        await task();
      } catch (error: unknown) {
        const failure = readDesktopFailure(error);
        setNotice({
          text:
            failure?.message ||
            (error instanceof Error ? error.message : "The request failed"),
          tone: "error",
        });
        refreshStatus();
      } finally {
        setBusy(false);
      }
    },
    [refreshStatus]
  );

  const takeControl = useCallback(
    () =>
      run(async () => {
        applyStatus(await server.takeDesktopControl({ agentId }));
        keyboardRef.current?.focus();
      }),
    [agentId, applyStatus, run, server]
  );

  const handBack = useCallback(
    () =>
      run(async () => {
        releaseButtons();
        await flushInput({ dropMoves: true });
        try {
          const next = await server.handBackDesktop({
            agentId,
            ...(note.trim() === "" ? {} : { note: note.trim() }),
          });
          applyStatus(next);
        } catch (error: unknown) {
          // 423 means the lease already ran out, so control is back with the agent: the hand-back is done.
          if (readDesktopFailure(error)?.statusCode !== HTTP_LOCKED) {
            throw error;
          }
          refreshStatus();
        }
        setNote("");
        setNotice({ text: "Control handed back.", tone: "success" });
      }),
    [
      agentId,
      applyStatus,
      flushInput,
      note,
      refreshStatus,
      releaseButtons,
      run,
      server,
    ]
  );

  // Clipboard writes must start inside the click, so the text is handed over as a pending blob.
  const copyFromRemote = useCallback(() => {
    setManualCopy(null);
    const read = server
      .getDesktopClipboard({ agentId })
      .then((result) => result.text);
    const clipboard =
      typeof navigator === "undefined" ? undefined : navigator.clipboard;
    const write = async () => {
      if (clipboard === undefined) {
        throw new Error("No clipboard access");
      }
      if (
        typeof ClipboardItem !== "undefined" &&
        typeof clipboard.write === "function"
      ) {
        await clipboard.write([
          new ClipboardItem({
            "text/plain": read.then(
              (text) => new Blob([text], { type: "text/plain" })
            ),
          }),
        ]);
        return;
      }
      await clipboard.writeText(await read);
    };
    run(async () => {
      try {
        await write();
        setNotice({ text: "Copied from the desktop.", tone: "success" });
      } catch (error: unknown) {
        // A refused read is the server's answer; a refused write leaves the text here to copy by hand.
        if (readDesktopFailure(error) !== null) {
          throw error;
        }
        setManualCopy(await read);
      }
    });
  }, [agentId, run, server]);

  const sendChord = useCallback(
    (keys: string) => {
      sendInput([{ keys, type: "key" }]);
      keyboardRef.current?.focus();
    },
    [sendInput]
  );

  const onChordClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      const { keys } = event.currentTarget.dataset;
      if (keys !== undefined) {
        sendChord(keys);
      }
    },
    [sendChord]
  );

  const onNoteChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setNote(event.target.value);
    },
    []
  );

  const onSendTextChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setSendText(event.target.value);
    },
    []
  );

  const onSendTextSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (sendText === "") {
        return;
      }
      setSendText("");
      run(() => pasteText(sendText));
    },
    [pasteText, run, sendText]
  );

  const onKeyboardFocus = useCallback(() => setKeyboardFocused(true), []);
  const onKeyboardBlur = useCallback(() => setKeyboardFocused(false), []);

  const onKeyboardKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      const native = event.nativeEvent;
      // Out of the Tab order by design: after the release chord, Tab moves through the page.
      if (isReleaseChord(native)) {
        event.preventDefault();
        event.currentTarget.blur();
        return;
      }
      if (!inControlRef.current) {
        return;
      }
      if (isPasteChord(native)) {
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
      if (!inControlRef.current) {
        return;
      }
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain");
      if (text !== "") {
        run(() => pasteText(text));
      }
    },
    [pasteText, run]
  );

  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (inControlRef.current) {
        event.preventDefault();
      }
    },
    []
  );

  const onFramePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!inControlRef.current) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      keyboardRef.current?.focus();
      const button = toDesktopButton(event.button);
      if (button !== null) {
        pressedRef.current.add(button);
      }
      sendInput(pointerActions(event, "down", frameRef.current));
    },
    [sendInput]
  );

  const onFramePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!inControlRef.current) {
        return;
      }
      sendInput(pointerActions(event, "move", frameRef.current));
    },
    [sendInput]
  );

  const onFramePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!inControlRef.current) {
        return;
      }
      const button = toDesktopButton(event.button);
      if (button !== null) {
        pressedRef.current.delete(button);
      }
      sendInput(pointerActions(event, "up", frameRef.current));
    },
    [sendInput]
  );

  const humanExpiresAt =
    controller?.kind === "human" && controller.isMe
      ? Date.parse(controller.expiresAt)
      : Number.NaN;
  const leaseLeftMs = humanExpiresAt - now;
  const showLeaseWarning =
    inControl &&
    Number.isFinite(leaseLeftMs) &&
    leaseLeftMs <= LEASE_WARNING_MS;
  const canTakeControl = status?.online === true && status.desktop === true;
  const notLive = problemText({ problem: frameProblem, status });

  return (
    <section
      aria-label="Desktop"
      className={cx("flex min-h-0 flex-col gap-3", className)}
      data-testid="desktop-screen"
    >
      <div className="flex flex-col gap-2">
        <p className="m-0 text-[var(--ws-muted)] text-xs">
          <span aria-live="polite">
            {status === null
              ? (statusError ?? "Loading…")
              : controllerLabel(status.controller)}
          </span>{" "}
          · <FrameAge frame={frame} />
        </p>
        <div className="flex flex-wrap gap-2">
          {inControl ? (
            <Button
              disabled={busy}
              onClick={handBack}
              size="sm"
              variant="primary"
            >
              Hand back
            </Button>
          ) : (
            <Button
              disabled={busy || !canTakeControl}
              onClick={takeControl}
              size="sm"
              variant="primary"
            >
              Take control
            </Button>
          )}
        </div>
      </div>

      {inControl ? (
        <TextAreaField
          label="Note for the agent (optional)"
          maxLength={NOTE_MAX_CHARS}
          onChange={onNoteChange}
          placeholder="Logged in as accounts@…"
          rows={2}
          value={note}
        />
      ) : null}

      {notice === null ? null : (
        <p
          className={cx(
            "m-0 text-xs leading-5",
            notice.tone === "error"
              ? "text-[var(--ws-danger)]"
              : "text-[var(--ws-muted)]"
          )}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.text}
        </p>
      )}
      {inputError === null ? null : (
        <p className="m-0 text-[var(--ws-danger)] text-xs" role="alert">
          {inputError}
        </p>
      )}
      {showLeaseWarning ? (
        <p className="m-0 text-[var(--ws-warn)] text-xs" role="alert">
          Control ends in {String(Math.max(0, Math.ceil(leaseLeftMs / 1000)))}s
          unless you use the desktop.
        </p>
      ) : null}

      <div
        className={cx(
          "relative max-h-[75vh] w-full shrink-0 overflow-hidden rounded-lg border border-[var(--ws-line)] bg-[var(--ws-bg)]",
          inControl && keyboardFocused && "ring-2 ring-[var(--ws-accent)]"
        )}
        data-testid="desktop-view"
        style={{
          aspectRatio: `${String(DESKTOP_SCREEN.width)} / ${String(DESKTOP_SCREEN.height)}`,
        }}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer surface mirrors the desktop; keys go through the sink textarea beside it */}
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: as above */}
        <div
          className={cx(
            "absolute inset-0 touch-none select-none",
            inControl ? "cursor-default" : "cursor-not-allowed"
          )}
          data-testid="desktop-frame"
          onContextMenu={onContextMenu}
          onLostPointerCapture={releaseButtons}
          onPointerCancel={releaseButtons}
          onPointerDown={onFramePointerDown}
          onPointerMove={onFramePointerMove}
          onPointerUp={onFramePointerUp}
          ref={frameRef}
        >
          {frame !== null && frameProblem?.kind !== "human_in_control" ? (
            <>
              <img
                alt="Remote desktop"
                className={cx(
                  "pointer-events-none h-full w-full object-contain",
                  notLive !== null && "opacity-40"
                )}
                draggable={false}
                height={DESKTOP_SCREEN.height}
                src={frame.url}
                width={DESKTOP_SCREEN.width}
              />
              {notLive === null ? null : (
                <div
                  className="absolute inset-0 flex items-center justify-center p-6"
                  data-testid="desktop-stale-label"
                  role="status"
                >
                  <span className="rounded-md bg-[var(--ws-surface)] px-3 py-2 text-center text-[var(--ws-text)] text-sm">
                    {notLive}
                  </span>
                </div>
              )}
            </>
          ) : (
            <div
              className="flex h-full w-full items-center justify-center p-6 text-center text-[var(--ws-muted)] text-sm"
              data-testid="desktop-placeholder"
              role="status"
            >
              {notLive ?? "Connecting to the desktop…"}
            </div>
          )}
        </div>
        <textarea
          aria-label="Desktop keyboard"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className="absolute top-0 left-0 size-[0.0625rem] resize-none overflow-hidden border-0 p-0 opacity-0"
          data-desktop-keyboard=""
          onBlur={onKeyboardBlur}
          onFocus={onKeyboardFocus}
          onKeyDown={onKeyboardKeyDown}
          onPaste={onKeyboardPaste}
          readOnly={!inControl}
          ref={keyboardRef}
          spellCheck={false}
          tabIndex={-1}
        />
      </div>

      <p className="m-0 text-[var(--ws-muted)] text-xs leading-5">
        {inControl
          ? "Click the screen to type into it. Press Ctrl+Alt+Shift to give the keyboard back to this page. Pasting sends your clipboard to the desktop and presses Ctrl+V."
          : "Take control to use the mouse and keyboard on this desktop."}
      </p>

      <div className="flex flex-col gap-2">
        <div
          aria-label="Keys the browser keeps"
          className="flex flex-wrap gap-2"
          role="toolbar"
        >
          {RESERVED_CHORDS.map(({ keys, label }) => (
            <Button
              data-keys={keys}
              disabled={!inControl}
              key={keys}
              onClick={onChordClick}
              size="sm"
              variant="subtle"
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={!inControl || busy}
            onClick={copyFromRemote}
            size="sm"
            variant="subtle"
          >
            Copy from remote
          </Button>
          <form
            className="flex min-w-0 flex-1 gap-2"
            onSubmit={onSendTextSubmit}
          >
            <input
              aria-label="Text to send"
              className="ws-focus h-7 min-w-0 flex-1 rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-2.5 text-[var(--ws-text)] text-xs placeholder:text-[var(--ws-muted)]"
              disabled={!inControl}
              onChange={onSendTextChange}
              placeholder="Paste here if pasting on the screen is blocked"
              value={sendText}
            />
            <Button
              disabled={!inControl || busy || sendText === ""}
              size="sm"
              type="submit"
              variant="subtle"
            >
              Send text
            </Button>
          </form>
        </div>
      </div>

      {manualCopy === null ? null : (
        <TextAreaField
          label="This browser blocked the copy. Select the text and copy it yourself:"
          readOnly
          rows={3}
          value={manualCopy}
        />
      )}
    </section>
  );
}
