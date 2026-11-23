/**
 * The minute tick's sweep for lost room work. A room post's wake (SL.2) and its
 * send to Slack (SL.3) each run in `waitUntil` with no backup, so a Worker that
 * dies at the wrong moment loses them and nothing retries. Each tick looks at
 * the posts of the last hour that are at least two minutes old (a job still
 * running is left alone) and finishes what is missing: it wakes the lead, or
 * the agents a Slack post names, for a person's post no wake has seen, and it
 * sends the posts of a linked room that have no `out` row. Both steps are safe
 * to repeat, because a post that was handled no longer matches.
 */
import type { Database } from "@repo/db";
import { ForbiddenError } from "../authz.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import { lostInboundPosts, unsentRoomPosts } from "./room-sweep-store.ts";

const SWEEP_ACTION = "slack.room_sweep";
const MINUTE_MS = 60_000;
/** A job still in `waitUntil` is given this long before the sweep takes over. */
export const ROOM_SWEEP_GRACE_MS = 2 * MINUTE_MS;
/** Older posts are left alone: a post the sweep cannot finish is not retried forever. */
export const ROOM_SWEEP_WINDOW_MS = 60 * MINUTE_MS;
/**
 * The sweep stops taking up posts after this long, so it ends before the next
 * tick starts and two sweeps do not work on the same post.
 */
export const ROOM_SWEEP_BUDGET_MS = 45_000;

export interface RoomSweepOptions {
  clock: Clock;
  db: Database;
  /** Sends one post to the linked Slack channel unless it already went. */
  send: (postId: string) => Promise<void>;
  /** Wakes the agents a person's post names. */
  wake: (principal: Principal, postId: string) => Promise<unknown>;
}

/** How many posts the sweep took up (it does not say whether each succeeded). */
export interface RoomSweepResult {
  sent: number;
  woken: number;
}

export const createRoomSweep = ({
  clock,
  db,
  send,
  wake,
}: RoomSweepOptions) => {
  const sweep = async (principal: Principal): Promise<RoomSweepResult> => {
    if (principal.kind !== "system") {
      throw new ForbiddenError(SWEEP_ACTION);
    }
    const now = clock.now().getTime();
    const outOfTime = () => clock.now().getTime() - now > ROOM_SWEEP_BUDGET_MS;
    const window = {
      after: new Date(now - ROOM_SWEEP_WINDOW_MS).toISOString(),
      before: new Date(now - ROOM_SWEEP_GRACE_MS).toISOString(),
    };
    // Oldest first: the first post of a topic opens its Slack thread.
    const result: RoomSweepResult = { sent: 0, woken: 0 };
    const unsent = (await unsentRoomPosts(db, window)).reverse();
    for (const postId of unsent) {
      if (outOfTime()) {
        break;
      }
      result.sent += 1;
      try {
        // biome-ignore lint/performance/noAwaitInLoops: a send reads the thread root the one before it wrote
        await send(postId);
      } catch (error) {
        console.error("Slack room sweep send failed", error);
      }
    }
    const lost = (await lostInboundPosts(db, window)).reverse();
    for (const postId of lost) {
      if (outOfTime()) {
        break;
      }
      result.woken += 1;
      try {
        // biome-ignore lint/performance/noAwaitInLoops: a wake can post and wake again, so they stay in order
        await wake(principal, postId);
      } catch (error) {
        console.error("Slack room sweep wake failed", error);
      }
    }
    return result;
  };

  return { sweep };
};

export type RoomSweep = ReturnType<typeof createRoomSweep>;
