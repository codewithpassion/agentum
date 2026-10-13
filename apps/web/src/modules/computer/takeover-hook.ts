import { createDb } from "#/db/client";
import {
  findPendingTakeover,
  type SettleTakeoverInput,
  settleTakeover,
} from "#/modules/questions/service";
import { type QuestionView, toQuestionViews } from "#/modules/questions/view";
import { findMembership, getWorkspaceById } from "#/modules/workspaces/service";

/**
 * A person's hand-back or cancel of an agent's takeover request. The settling
 * itself lives with the questions module, which owns the rows; this file turns
 * a person's click into that call and reports the outcome for the route.
 */

export interface TakeoverEvent {
  agentId: string;
  env: Env;
  userId: string;
  workspaceId: string;
}

export interface HandBackEvent extends TakeoverEvent {
  note: string | null;
}

/**
 * `none`: nothing was waiting, so there was nothing to settle. `already_handled`:
 * something was waiting, and another request settled it first.
 */
export type TakeoverOutcome =
  | { kind: "none" }
  | { kind: "settled"; question: QuestionView }
  | { kind: "already_handled" };

export type HandBackHook = (event: HandBackEvent) => Promise<TakeoverOutcome>;
export type CancelTakeoverHook = (
  event: TakeoverEvent
) => Promise<TakeoverOutcome>;

export interface PendingTakeover {
  createdAt: number;
  id: string;
  reason: string;
}

export type PendingTakeoverOf = (
  env: Env,
  workspaceId: string,
  agentId: string
) => Promise<PendingTakeover | null>;

const HANDED_BACK_TEXT = "Handed back.";
const DECLINED_TEXT = "The person declined to take over.";

const settle = async (
  event: TakeoverEvent,
  input: Pick<SettleTakeoverInput, "status" | "text">
): Promise<TakeoverOutcome> => {
  const db = createDb(event.env.DB);
  const workspace = await getWorkspaceById(db, event.workspaceId);
  const member = await findMembership(db, event.workspaceId, event.userId);
  if (!(workspace && member)) {
    throw new Error("The signed-in person is not a member of this workspace.");
  }

  const result = await settleTakeover(db, event.env, workspace, event.agentId, {
    by: {
      // The reply is authored by the person; the row records their membership.
      authorId: member.clerkUserId,
      authorType: "user",
      id: member.id,
      via: "web",
    },
    status: input.status,
    text: input.text,
  });
  if (!result.ok) {
    return result.reason === "none-pending"
      ? { kind: "none" }
      : { kind: "already_handled" };
  }
  const [question] = await toQuestionViews(db, workspace.id, [result.question]);
  if (!question) {
    throw new Error("A settled takeover has no view.");
  }
  return { kind: "settled", question };
};

/** Hands the desktop back. The note, when given, is what wakes the agent. */
export const onHandBack: HandBackHook = (event) =>
  settle(event, {
    status: "handed_back",
    text: event.note?.trim() || HANDED_BACK_TEXT,
  });

/** The person declines to take over. The agent is woken to carry on without it. */
export const onCancelTakeover: CancelTakeoverHook = (event) =>
  settle(event, { status: "cancelled", text: DECLINED_TEXT });

/** The takeover the desktop screen shows as pending, or null when none waits. */
export const pendingTakeoverOf = async (
  env: Env,
  workspaceId: string,
  agentId: string
): Promise<PendingTakeover | null> => {
  const db = createDb(env.DB);
  const pending = await findPendingTakeover(db, workspaceId, agentId);
  if (!pending) {
    return null;
  }
  // Past its deadline but not yet swept: it no longer waits on anybody.
  if (pending.expiresAt !== null && pending.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  return {
    createdAt: pending.createdAt.getTime(),
    id: pending.id,
    reason: pending.prompt,
  };
};
