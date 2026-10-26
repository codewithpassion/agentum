import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { DESKTOP_SCREEN, type DesktopAction } from "./desktop-input.ts";
import { createInputCoalescer } from "./desktop-input-coalescer.ts";
import type { Connection } from "./desktop-status.ts";
import {
  type DesktopProblem,
  type DesktopStatus,
  type DesktopStream,
  desktopStreamPath,
  openDesktopStream,
  streamUrl,
} from "./desktop-stream.ts";

/** Input codes that mean the lease is gone, so the status is already on its way. */
const LOST_CONTROL_CODES: ReadonlySet<string> = new Set([
  "human_in_control",
  "lease_required",
]);

/** Draws a JPEG onto the canvas. A newer frame that finished first wins. */
function createPainter(canvas: RefObject<HTMLCanvasElement | null>) {
  let requested = 0;
  let painted = 0;
  return async (jpeg: Blob): Promise<boolean> => {
    requested += 1;
    const seq = requested;
    const bitmap = await createImageBitmap(jpeg);
    const target = canvas.current;
    const context = target?.getContext("2d");
    if (!(context && target) || seq < painted) {
      bitmap.close();
      return false;
    }
    painted = seq;
    context.drawImage(bitmap, 0, 0, target.width, target.height);
    bitmap.close();
    return true;
  };
}

export interface DesktopScreen {
  /** Attach to the `<canvas>` the frames are drawn on. */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  connection: Connection;
  /** Sends everything queued now. `dropMoves` leaves out pointer moves. */
  flushInput: (options?: { dropMoves?: boolean }) => void;
  /** True once a frame is on the canvas and until a problem takes it away. */
  hasFrame: boolean;
  inputError: string | null;
  problem: DesktopProblem | null;
  sendInput: (actions: DesktopAction[]) => void;
  status: DesktopStatus | null;
}

/**
 * Follows one machine's desktop over its viewer WebSocket: frames go to the
 * canvas, status and problems into state, and input out through a coalescer.
 * Input is only accepted by the server while this person holds the lease.
 */
export function useDesktopScreen(machineId: string): DesktopScreen {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<DesktopStream | null>(null);
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [problem, setProblem] = useState<DesktopProblem | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [hasFrame, setHasFrame] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);

  const coalescerRef = useRef<ReturnType<typeof createInputCoalescer> | null>(
    null
  );
  coalescerRef.current ??= createInputCoalescer({
    send: (batch) => streamRef.current?.sendInput(batch) ?? false,
  });

  useEffect(() => {
    const paint = createPainter(canvasRef);
    const stream = openDesktopStream({
      handlers: {
        onClosed: () => setConnection("reconnecting"),
        onFrame: (jpeg) => {
          paint(jpeg)
            .then((drawn) => {
              if (drawn) {
                setHasFrame(true);
                setProblem(null);
              }
            })
            .catch(() => undefined);
        },
        onInputError: (code, message) => {
          setInputError(
            LOST_CONTROL_CODES.has(code)
              ? "You no longer control the desktop."
              : message || "Input was not delivered"
          );
          coalescerRef.current?.reset();
        },
        onOpen: () => {
          setConnection("open");
          setInputError(null);
        },
        onProblem: (next) => {
          setProblem(next);
          if (next.kind === "human_in_control") {
            canvasRef.current
              ?.getContext("2d")
              ?.clearRect(0, 0, DESKTOP_SCREEN.width, DESKTOP_SCREEN.height);
            setHasFrame(false);
          }
        },
        onStatus: (next) => {
          setStatus(next);
          // Control is back, so an error about losing it no longer applies.
          if (next.youHaveControl) {
            setInputError(null);
          }
        },
      },
      url: streamUrl({
        host: window.location.host,
        pathname: desktopStreamPath(machineId),
        protocol: window.location.protocol,
      }),
    });
    streamRef.current = stream;
    const coalescer = coalescerRef.current;
    return () => {
      stream.close();
      streamRef.current = null;
      coalescer?.reset();
    };
  }, [machineId]);

  const sendInput = useCallback((actions: DesktopAction[]) => {
    if (actions.length > 0) {
      coalescerRef.current?.push(actions);
    }
  }, []);

  const flushInput = useCallback(
    (options?: { dropMoves?: boolean }) => coalescerRef.current?.flush(options),
    []
  );

  return {
    canvasRef,
    connection,
    flushInput,
    hasFrame,
    inputError,
    problem,
    sendInput,
    status,
  };
}
