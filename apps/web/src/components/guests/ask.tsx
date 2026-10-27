/** biome-ignore-all lint/performance/noJsxPropsBind: Artifact-scoped composer actions. */
/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: Optional storage can be empty; React lifetime refs change during asynchronous actions. */
import type {
  GuestAskAvailability,
  GuestAskResult,
} from "@repo/protocol/guest";
import { guestAskSchema } from "@repo/protocol/guest";
import { useEffect, useRef, useState } from "react";
import type { EditorRole } from "../live-artifacts/editor-ports";
import { guestHttp } from "./http";
import type { GuestServices } from "./services";

interface Pending {
  agentId?: string;
  requestId: string;
  text: string;
}
const readPending = (key: string): Pending | undefined => {
  try {
    const value = guestAskSchema.safeParse(
      JSON.parse(sessionStorage.getItem(key) ?? "null")
    );
    if (value.success) {
      return value.data;
    }
  } catch {
    /* Storage may be disabled. In-memory retries still retain identity. */
  }
};
export function GuestAsk({
  services,
  role,
  contextVersion,
  beforeSend,
  sent,
  onAvailability,
}: {
  services: GuestServices;
  role: EditorRole;
  contextVersion: number;
  beforeSend: () => Promise<void>;
  sent: () => void;
  onAvailability: (available: boolean) => void;
}) {
  const key = services.endpoint("ask");
  const [pending, setPending] = useState(() => readPending(key));
  const [text, setText] = useState(() => readPending(key)?.text ?? "");
  const [availability, setAvailability] = useState<GuestAskAvailability>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh trusted location after an explicit selection action or room role change.
  useEffect(() => {
    let disposed = false;
    let reading = false;
    const refresh = async () => {
      if (reading) {
        return;
      }
      reading = true;
      try {
        await beforeSend();
        const result = await guestHttp.json<GuestAskAvailability>(
          services.endpoint("ask-availability")
        );
        if (!disposed) {
          setAvailability(result);
        }
      } catch {
        if (!disposed) {
          setAvailability(undefined);
        }
      } finally {
        reading = false;
      }
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [services, role, contextVersion, beforeSend]);
  const available =
    availability?.available &&
    availability.role !== "viewer" &&
    role !== "viewer";
  useEffect(() => {
    onAvailability(Boolean(available));
    return () => onAvailability(false);
  }, [available, onAvailability]);
  const send = async () => {
    if (busy || !available || !text.trim()) {
      return;
    }
    const request = pending ?? {
      agentId: availability?.agent?.id,
      requestId: crypto.randomUUID(),
      text: text.trim(),
    };
    setPending(request);
    try {
      sessionStorage.setItem(key, JSON.stringify(request));
    } catch {
      /* Optional storage. */
    }
    setBusy(true);
    setNotice("");
    try {
      await beforeSend();
      const result = await guestHttp.json<GuestAskResult>(key, request);
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* Optional storage. */
      }
      if (alive.current) {
        sent();
        setPending(undefined);
        setText("");
        setNotice(
          `Request ${result.status}. Follow the shared agent thread below.`
        );
      }
    } catch {
      if (alive.current) {
        setNotice(
          "Request could not be confirmed. Retry uses the same request. Access, agent readiness or your daily limit may have changed."
        );
      }
    } finally {
      if (alive.current) {
        setBusy(false);
      }
    }
  };
  const where = availability?.where;
  const submitLabel = pending ? "Retry request" : "Send request";
  return (
    <section aria-label="Ask agent" className="guest-comments guest-ask">
      <h2>Ask agent</h2>
      <p>
        {available
          ? `Ask ${availability?.agent?.name} about this shared artifact. Agent edits become suggestions for review.`
          : "Agent requests are currently unavailable for your access or this artifact."}
      </p>
      {where !== undefined && (
        <p>
          Room context:{" "}
          {where.selection ||
            (where.slideId
              ? `slide ${where.slideNumber ?? where.slideId}`
              : "current location")}
          {where.elementIds?.length
            ? ` · ${where.elementIds.length} selected elements`
            : ""}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <label>
          Message to agent
          <textarea
            disabled={busy || Boolean(pending) || !available}
            maxLength={16_000}
            onChange={(event) => setText(event.target.value)}
            value={text}
          />
        </label>
        <button disabled={busy || !available || !text.trim()} type="submit">
          {busy ? "Sending…" : <span>{submitLabel}</span>}
        </button>
      </form>
      {pending && !busy && (
        <button
          onClick={() => {
            try {
              sessionStorage.removeItem(key);
            } catch {
              /* Optional storage. */
            }
            setPending(undefined);
            setNotice(
              "Saved retry cleared. The earlier request may still run in the shared thread."
            );
          }}
          type="button"
        >
          Discard saved retry
        </button>
      )}
      {pending && !busy && (
        <p>The saved request is kept for retry, including after reload.</p>
      )}
      <p role="status">{notice}</p>
      <p>
        Requests needing approval wait for a workspace member. Guests cannot
        answer approvals.
      </p>
    </section>
  );
}
