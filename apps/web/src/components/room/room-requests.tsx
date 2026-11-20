import { RAIL_REFRESH_EVENT } from "@repo/db/shared";
import { useCallback, useState } from "react";
import { usePolledQuery } from "#/components/inbox/use-polled-query";
import { RequestCard } from "#/components/requests/request-card.tsx";
import {
  type AnswerPayload,
  isConflict,
  type RequestView,
  viewFromRecord,
} from "#/components/requests/request-card-logic.ts";
import { useNowMs } from "#/components/task/use-now-ms.ts";
import { getTrpc } from "#/integrations/trpc/client";
import { requestsOfTopic, topicSessionIds } from "./room-logic.ts";
import { memberKey, type RoomDirectory } from "./room-types.ts";

/** `sessions.list` returns at most this many sessions. */
const INBOX_SESSION_LIMIT = 50;

interface WaitingRequest {
  agentId: string;
  view: RequestView;
}

interface AnsweredRequest extends WaitingRequest {
  /** The newest post's id when it was answered. */
  newestPostId: string | null;
}

/**
 * The requests a topic's tasks are waiting on. A run that waits has not posted
 * yet, so they are found through the topic's inbox sessions, not its posts.
 */
const loadWaiting = async (threadId: string): Promise<WaitingRequest[]> => {
  const trpc = getTrpc();
  const pending = await trpc.requests.pending.query({});
  if (pending.length === 0) {
    return [];
  }
  const sessions = await trpc.sessions.list.query({
    limit: INBOX_SESSION_LIMIT,
    origin: "inbox",
  });
  const ids = topicSessionIds(sessions, threadId);
  return requestsOfTopic(pending, ids).flatMap((record) => {
    const view = viewFromRecord(record, null);
    return view === null ? [] : [{ agentId: record.agentId, view }];
  });
};

interface RoomRequestsProps {
  directory: RoomDirectory;
  /** The newest post's id, or null. An answered card goes once a newer post lands. */
  newestPostId: string | null;
  threadId: string;
}

/** Requests raised in the topic's tasks, with their buttons. Answered ones stay, as a local confirmation, until a newer post lands or the topic is left. */
export function RoomRequests({
  directory,
  newestPostId,
  threadId,
}: RoomRequestsProps) {
  const nowMs = useNowMs();
  const waiting = usePolledQuery(() => loadWaiting(threadId), null);
  const { refresh } = waiting;
  const [answered, setAnswered] = useState<
    Readonly<Record<string, AnsweredRequest>>
  >({});

  const answer = useCallback(
    async (view: RequestView, payload: AnswerPayload) => {
      const agentId =
        waiting.data?.find((entry) => entry.view.id === view.id)?.agentId ?? "";
      let settled: NonNullable<RequestView["settled"]>;
      try {
        const record = await getTrpc().requests.answer.mutate({
          ...payload,
          requestId: view.id,
        });
        settled = {
          answer: record.answer ?? payload,
          answeredBy: record.answeredBy,
          status: "answered",
          via: "web",
          ...(record.sendError === null ? {} : { sendError: record.sendError }),
        };
      } catch (cause) {
        if (!isConflict(cause)) {
          throw cause;
        }
        settled = { status: "conflict" };
      }
      setAnswered((current) => ({
        ...current,
        [view.id]: { agentId, newestPostId, view: { ...view, settled } },
      }));
      window.dispatchEvent(new Event(RAIL_REFRESH_EVENT));
      refresh();
    },
    [newestPostId, refresh, waiting.data]
  );

  const open = (waiting.data ?? []).filter(
    (entry) => answered[entry.view.id] === undefined
  );
  const done = Object.values(answered).filter(
    (entry) => entry.newestPostId === newestPostId
  );
  const shown = [...open, ...done];
  if (nowMs === null || shown.length === 0) {
    return null;
  }

  return (
    <ul aria-label="Waiting on you" className="flex flex-col gap-3">
      {shown.map((entry) => (
        <li
          className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
          key={entry.view.id}
        >
          {entry.view.settled === null ? (
            <p className="font-semibold">
              {`${directory.get(memberKey("agent", entry.agentId))?.name ?? "An agent"} needs you`}
            </p>
          ) : null}
          <RequestCard
            nowMs={nowMs}
            onAnswer={answer}
            onClosed={refresh}
            view={entry.view}
          />
        </li>
      ))}
    </ul>
  );
}
