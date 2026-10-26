import { useEffect, useState } from "react";
import { getTrpc } from "#/integrations/trpc/client";
import type { MailThreadView } from "#/integrations/trpc/types";

/** How often the mail card reads the linked thread again while the run is going. */
export const MAIL_REFRESH_MS = 5000;

/**
 * The mail thread linked to the task, or null when it has none. It reads
 * `threadForTask` on mount, every 5 s while the run is running, and once
 * more when the run stops running, since mail the agent sends does not reach
 * the session stream.
 */
export function useTaskMail(
  runId: string,
  agentId: string,
  running: boolean
): {
  /** The agent's own mailbox address, read once, or null until it arrives. */
  address: string | null;
  error: string | null;
  thread: MailThreadView | null;
} {
  const [address, setAddress] = useState<string | null>(null);
  const [thread, setThread] = useState<MailThreadView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    getTrpc()
      .mailbox.get.query({ agentId })
      .then((box) => {
        if (current) {
          setAddress(box?.address ?? null);
        }
      })
      .catch(() => {
        // Without the address the trigger step keeps its plain wording.
      });
    return () => {
      current = false;
    };
  }, [agentId]);

  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const next = await getTrpc().threadForTask.query({ taskId: runId });
        if (current) {
          setThread(next);
          setError(null);
        }
      } catch (cause) {
        if (current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };
    load();
    if (!running) {
      return () => {
        current = false;
      };
    }
    const timer = setInterval(load, MAIL_REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [runId, running]);

  return { address, error, thread };
}
