// The one rule for who may see a person's private notes (`memory/private/<userId>.md`).
// The prompt, the library tools, the daemon routes, the VM sync, the audience
// and the session reads all ask it, so they cannot disagree.
import type { Database } from "@repo/db";
import { sessions } from "@repo/db/schema/sessions";
import { and, eq } from "drizzle-orm";

/** The parts of a session the rule reads. */
export interface PrivateNotesSession {
  actorId: string;
  actorKind: string;
  origin: string;
  private: boolean;
}

/**
 * The person whose private notes a run may see, or null when it may see none.
 * A run sees them only when its session is private or has origin `ui`, and the
 * session's actor is the person the run works for. Team rooms, Q&A, Slack
 * channels, mail, artifact chats, A2A, routines and triggers are shared, so
 * they get none even when one person started the run.
 */
export const privateNotesUserOf = (
  run: { onBehalfOfUserId: string | null },
  session: PrivateNotesSession | null | undefined
): string | null => {
  const userId = run.onBehalfOfUserId;
  if (userId === null || !session) {
    return null;
  }
  const isPersonal = session.private || session.origin === "ui";
  return isPersonal &&
    session.actorKind === "user" &&
    session.actorId === userId
    ? userId
    : null;
};

/** `privateNotesUserOf` for a run whose session has not been read yet. */
export const loadPrivateNotesUser = async (
  db: Database,
  run: {
    onBehalfOfUserId: string | null;
    sessionId: string;
    workspaceId: string;
  }
): Promise<string | null> => {
  if (run.onBehalfOfUserId === null) {
    return null;
  }
  const [session] = await db
    .select({
      actorId: sessions.actorId,
      actorKind: sessions.actorKind,
      origin: sessions.origin,
      private: sessions.private,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, run.sessionId),
        eq(sessions.workspaceId, run.workspaceId)
      )
    )
    .limit(1);
  return privateNotesUserOf(run, session);
};
