// The SSE route `GET /api/sessions/:sessionId/stream`. A user (Clerk cookie
// session) may open the stream of a session the services let them read. The
// route subscribes to the session's Durable Object first, then replays the
// stored events after the resume point from D1, then relays the live frames.
// An event that lands between the subscribe and the D1 read is in both, so the
// relay drops the live copy of any event the replay already sent. Mount with
// `runtimeRoutes.route("/api/sessions", sessionStreamRoutes({ session }))`.

import type { EventType } from "@repo/db/shared";
import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import {
  EVENT_QUERY_MAX_LIMIT,
  type EventRecord,
  type EventsService,
} from "@repo/services/events";
import type { Principal } from "@repo/services/workspaces";
import type { Context, Hono } from "hono";
import { encodeFrame } from "../session-stream-core.ts";
import { eventFrame, STREAM_EVENT_TYPES } from "../session-stream-frames.ts";
import { type AppEnv, cookieGroup } from "./groups.ts";
import { jsonError, type SessionDeps, sessionUser } from "./respond.ts";

const UNAUTHORIZED = 401;
const BAD_REQUEST = 400;
const NOT_FOUND = 404;

const SIGN_IN = "Sign in required.";
const NOT_FOUND_MESSAGE = "Not found.";

export const STREAM_HEADERS = {
  "Cache-Control": "no-cache, no-transform",
  "Content-Type": "text/event-stream",
  "X-Accel-Buffering": "no",
};

const SSE_BLOCK_END = "\n\n";
/** The longest event id the events query accepts. */
export const RESUME_ID_MAX = 200;
const ID_LINE = /^id: (.+)$/m;

export type SessionStreamRouteDeps = SessionDeps;

type RouteContext = Context<AppEnv>;
type UserPrincipal = Extract<Principal, { kind: "user" }>;

interface Replay {
  /** The ids of the events in `text`. */
  ids: Set<string>;
  /** The SSE text of the replayed events, in id order. */
  text: string;
}

export const NO_REPLAY: Replay = { ids: new Set(), text: "" };

/** Which stored events a replay reads, and which of them it keeps. */
export interface ReplayScope {
  /** Drops a stored event when it resolves false. Every event is kept by default. */
  keep?: (record: EventRecord) => Promise<boolean>;
  /** Only the events of this session. Every session of the workspace by default. */
  sessionId?: string;
  types: readonly EventType[];
}

/** The stored events in `scope` after `after`, as SSE text, read page by page. */
export const replay = async (
  events: EventsService,
  principal: UserPrincipal,
  scope: ReplayScope,
  after: string
): Promise<Replay> => {
  const ids = new Set<string>();
  let text = "";
  let cursor = after;
  let page: EventRecord[];
  do {
    // biome-ignore lint/performance/noAwaitInLoops: each page starts after the last id of the one before
    page = await events.query(principal, principal.workspaceId, {
      after: cursor,
      limit: EVENT_QUERY_MAX_LIMIT,
      sessionId: scope.sessionId,
      types: [...scope.types],
    });
    const kept = await Promise.all(
      page.map((record) => scope.keep?.(record) ?? true)
    );
    for (const [index, record] of page.entries()) {
      if (kept[index]) {
        ids.add(record.id);
        text += encodeFrame(eventFrame(record));
      }
    }
    cursor = page.at(-1)?.id ?? cursor;
  } while (page.length === EVENT_QUERY_MAX_LIMIT);
  return { ids, text };
};

/** True when a complete SSE block is an event the replay already sent. */
const isReplayed = (block: string, replayed: ReadonlySet<string>): boolean => {
  const id = ID_LINE.exec(block)?.[1];
  return id !== undefined && replayed.has(id);
};

/**
 * The replay, then the live body with the replayed events dropped. Cancelling
 * the response cancels the live body, which ends the Durable Object subscription.
 */
export const relay = (
  replayed: Replay,
  live: ReadableStream<Uint8Array>,
  keep?: (block: string) => Promise<boolean>
): ReadableStream<Uint8Array> => {
  const reader = live.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let replaySent = false;
  const pullOnce = async (
    controller: ReadableStreamDefaultController<Uint8Array>
  ): Promise<void> => {
    if (!replaySent) {
      replaySent = true;
      if (replayed.text !== "") {
        controller.enqueue(encoder.encode(replayed.text));
        return;
      }
    }
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: the live body is read one chunk at a time
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(SSE_BLOCK_END);
      buffer = blocks.pop() ?? "";
      const fresh = blocks.filter((block) => !isReplayed(block, replayed.ids));
      const kept = await Promise.all(
        fresh.map((block) => keep?.(block) ?? true)
      );
      const forward = fresh
        .filter((_block, index) => kept[index])
        .map((block) => `${block}${SSE_BLOCK_END}`)
        .join("");
      if (forward !== "") {
        controller.enqueue(encoder.encode(forward));
        return;
      }
    }
  };
  return new ReadableStream<Uint8Array>({
    cancel: (reason) => reader.cancel(reason),
    pull: async (controller) => {
      try {
        await pullOnce(controller);
      } catch (error: unknown) {
        // A failed pull does not run `cancel`, so end the subscription here.
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
    },
  });
};

/** The user behind the Clerk session, or null when there is none or its org has no workspace row. */
const authenticate = async (
  c: RouteContext,
  deps: SessionStreamRouteDeps
): Promise<UserPrincipal | null> => {
  const principal = await sessionUser(c, deps);
  return principal?.kind === "user" ? principal : null;
};

/** True when the principal may read the session. A hidden session and an unknown one read the same. */
const canRead = async (
  c: RouteContext,
  principal: UserPrincipal,
  sessionId: string
): Promise<boolean> => {
  try {
    await c.get("composed").services.sessions.get(principal, sessionId);
    return true;
  } catch (error: unknown) {
    if (isServiceError(error) || isForbiddenError(error)) {
      return false;
    }
    throw error;
  }
};

export const sessionStreamRoutes = (
  deps: SessionStreamRouteDeps
): Hono<AppEnv> => {
  const routes = cookieGroup();

  routes.get("/:sessionId/stream", async (c) => {
    const principal = await authenticate(c, deps);
    if (!principal) {
      return jsonError(c, UNAUTHORIZED, SIGN_IN);
    }
    const sessionId = c.req.param("sessionId");
    if (!(await canRead(c, principal, sessionId))) {
      return jsonError(c, NOT_FOUND, NOT_FOUND_MESSAGE);
    }

    const resume = c.req.header("Last-Event-ID") || c.req.query("after");
    if (resume && resume.length > RESUME_ID_MAX) {
      return jsonError(c, BAD_REQUEST, "Invalid resume point.");
    }
    const namespace = c.env.SESSION_STREAM;
    // Subscribe before the D1 read, so no event falls between the two.
    const live = await namespace.get(namespace.idFromName(sessionId)).fetch(
      new Request("https://session-stream/stream", {
        signal: c.req.raw.signal,
      })
    );
    if (!live.body) {
      throw new Error("The session stream sent no body");
    }
    const liveBody = live.body;

    let replayed = NO_REPLAY;
    if (resume) {
      try {
        replayed = await replay(
          c.get("composed").services.events,
          principal,
          { sessionId, types: STREAM_EVENT_TYPES },
          resume
        );
      } catch (error: unknown) {
        await liveBody.cancel();
        throw error;
      }
    }

    return new Response(relay(replayed, liveBody), { headers: STREAM_HEADERS });
  });

  return routes;
};
