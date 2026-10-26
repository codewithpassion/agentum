import { type ChangeEvent, useCallback, useId, useRef, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Label } from "#/components/ui/label.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { cn } from "#/lib/utils.ts";
import {
  readRemoteClipboard,
  writeRemoteClipboard,
} from "./desktop-clipboard.ts";
import { DESKTOP_SCREEN } from "./desktop-input.ts";
import { canTakeOver, controllerLabel, notLiveText } from "./desktop-status.ts";
import { useDesktopInput } from "./use-desktop-input.ts";
import { useDesktopScreen } from "./use-desktop-screen.ts";

const NOTE_MAX_CHARS = 2000;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "The request failed";

/** What the agent's open takeover request lets this person do. */
export interface TakeoverControls {
  /** Withdraws the request. */
  cancel: () => Promise<void>;
  /** Hands the desktop back to the agent: settles the request and resumes the run. */
  handBack: (note: string) => Promise<void>;
  reason: string;
  /** Takes the desktop for this person. */
  take: () => Promise<void>;
}

export interface DesktopScreenProps {
  /** The computer whose desktop this is. */
  machineId: string;
  /** The agent's open request for a person, or null when it has none. */
  takeover: TakeoverControls | null;
}

function ControlBar({
  busy,
  onCopy,
  onHandBack,
}: {
  busy: boolean;
  onCopy: () => void;
  onHandBack: (note: string) => Promise<boolean>;
}) {
  const noteId = useId();
  const [finishing, setFinishing] = useState(false);
  const [note, setNote] = useState("");
  const startFinishing = useCallback(() => setFinishing(true), []);
  const keepDriving = useCallback(() => setFinishing(false), []);
  const changeNote = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => setNote(event.target.value),
    []
  );
  const handBack = useCallback(async () => {
    if (await onHandBack(note.trim())) {
      setNote("");
      setFinishing(false);
    }
  }, [note, onHandBack]);
  return (
    <div className="flex flex-col gap-2">
      {finishing ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={noteId}>Note for the agent (optional)</Label>
          <Textarea
            disabled={busy}
            id={noteId}
            maxLength={NOTE_MAX_CHARS}
            onChange={changeNote}
            placeholder="Logged in as accounts@…"
            rows={2}
            value={note}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {finishing ? (
          <>
            <Button disabled={busy} onClick={handBack} size="sm" type="button">
              Hand back
            </Button>
            <Button
              disabled={busy}
              onClick={keepDriving}
              size="sm"
              type="button"
              variant="outline"
            >
              Keep driving
            </Button>
          </>
        ) : (
          <Button
            disabled={busy}
            onClick={startFinishing}
            size="sm"
            type="button"
          >
            I&apos;m done
          </Button>
        )}
        <Button
          disabled={busy}
          onClick={onCopy}
          size="sm"
          type="button"
          variant="outline"
        >
          Copy from remote
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Click the screen to type into it. Press Ctrl+Alt+Shift to give the
        keyboard back to this page. Pasting sends your clipboard to the desktop.
      </p>
    </div>
  );
}

function TakeOverBar({
  busy,
  canTake,
  hasRequest,
  onCancel,
  onTake,
}: {
  busy: boolean;
  canTake: boolean;
  hasRequest: boolean;
  onCancel: () => void;
  onTake: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        disabled={busy || !canTake}
        onClick={onTake}
        size="sm"
        type="button"
      >
        Take over
      </Button>
      {hasRequest ? (
        <Button
          disabled={busy}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
      ) : null}
      <span className="text-muted-foreground text-xs">
        {hasRequest
          ? "The agent waits while you drive. Hand back with “I’m done”."
          : "You can take over when the agent asks for you."}
      </span>
    </div>
  );
}

/**
 * The live view of an agent's desktop. Anyone who can open the task watches;
 * mouse and keyboard reach the desktop only while this person holds it, which
 * the agent's open takeover request allows.
 */
export function DesktopScreen({ machineId, takeover }: DesktopScreenProps) {
  const screen = useDesktopScreen(machineId);
  const { canvasRef, connection, flushInput, hasFrame, problem, sendInput } =
    screen;
  const { status } = screen;
  const inControl = status?.youHaveControl === true;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Runs a request with the busy and error state. False when it failed. */
  const run = useCallback(async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await task();
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const pasteText = useCallback(
    (text: string) =>
      run(async () => {
        flushInput();
        await writeRemoteClipboard(machineId, text);
        sendInput([{ keys: "ctrl+v", type: "key" }]);
        flushInput();
      }),
    [flushInput, machineId, run, sendInput]
  );

  const input = useDesktopInput({
    enabled: inControl,
    onPaste: pasteText,
    sendInput,
    surface: surfaceRef,
  });

  const { releaseButtons } = input;

  const take = useCallback(
    () =>
      run(async () => {
        await takeover?.take();
        input.keyboard.ref.current?.focus();
      }),
    [input.keyboard.ref, run, takeover]
  );

  const handBack = useCallback(
    (note: string) =>
      run(async () => {
        releaseButtons();
        flushInput({ dropMoves: true });
        await takeover?.handBack(note);
      }),
    [flushInput, releaseButtons, run, takeover]
  );

  const cancel = useCallback(
    () =>
      run(async () => {
        await takeover?.cancel();
      }),
    [run, takeover]
  );

  const copyFromRemote = useCallback(
    () =>
      run(async () => {
        const text = await readRemoteClipboard(machineId);
        await navigator.clipboard.writeText(text);
        setNotice("Copied from the desktop.");
      }),
    [machineId, run]
  );

  const notLive = notLiveText({ connection, problem, status });
  const live = hasFrame && notLive === null;

  return (
    <div className="flex flex-col gap-2.5" data-testid="desktop-screen">
      {takeover === null ? null : (
        <p
          className="rounded-lg bg-muted px-2.5 py-1.5 text-sm"
          data-testid="desktop-takeover-reason"
        >
          The agent asked you to take over: {takeover.reason}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground text-xs">
        <span aria-live="polite">{controllerLabel(status)}</span>
        {live ? (
          <span className="rounded-full bg-destructive/10 px-2 py-0.5 font-medium text-destructive">
            ● Live
          </span>
        ) : null}
      </div>
      <div
        className={cn(
          "relative w-full overflow-hidden rounded-lg border bg-muted",
          input.keyboardFocused && inControl && "ring-2 ring-ring"
        )}
        style={{
          aspectRatio: `${String(DESKTOP_SCREEN.width)} / ${String(DESKTOP_SCREEN.height)}`,
        }}
      >
        <div
          {...input.surface}
          className={cn(
            "absolute inset-0 touch-none select-none",
            inControl ? "cursor-default" : "cursor-not-allowed"
          )}
          data-testid="desktop-frame"
          ref={surfaceRef}
        >
          <canvas
            aria-label="Remote desktop"
            className={cn(
              "pointer-events-none size-full object-contain",
              hasFrame ? "" : "invisible",
              notLive !== null && "opacity-40"
            )}
            height={DESKTOP_SCREEN.height}
            ref={canvasRef}
            width={DESKTOP_SCREEN.width}
          />
          {live ? null : (
            <div
              className="absolute inset-0 flex items-center justify-center p-6 text-center text-muted-foreground text-sm"
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
          className="absolute top-0 left-0 size-px resize-none overflow-hidden border-0 p-0 opacity-0"
          onBlur={input.keyboard.onBlur}
          onFocus={input.keyboard.onFocus}
          onKeyDown={input.keyboard.onKeyDown}
          onPaste={input.keyboard.onPaste}
          readOnly={!inControl}
          ref={input.keyboard.ref}
          spellCheck={false}
          tabIndex={-1}
        />
      </div>

      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {screen.inputError === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {screen.inputError}
        </p>
      )}
      {notice === null ? null : (
        <p className="text-muted-foreground text-sm" role="status">
          {notice}
        </p>
      )}

      {inControl ? (
        <ControlBar busy={busy} onCopy={copyFromRemote} onHandBack={handBack} />
      ) : (
        <TakeOverBar
          busy={busy}
          canTake={canTakeOver({ hasTakeover: takeover !== null, status })}
          hasRequest={takeover !== null}
          onCancel={cancel}
          onTake={take}
        />
      )}
    </div>
  );
}
