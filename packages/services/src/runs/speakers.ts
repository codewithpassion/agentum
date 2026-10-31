import type { Database } from "@repo/db";
import { sessions } from "@repo/db/schema/sessions";
import { and, eq } from "drizzle-orm";

/** Session metadata, never message text, decides whether speaker instructions apply. */
export const sessionSupportsSpeakers = async (
  db: Database,
  run: { sessionId: string; workspaceId: string }
): Promise<boolean> => {
  const [session] = await db
    .select({ origin: sessions.origin })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, run.sessionId),
        eq(sessions.workspaceId, run.workspaceId)
      )
    )
    .limit(1);
  return (
    session?.origin === "artifact" ||
    session?.origin === "slack" ||
    session?.origin === "a2a"
  );
};
