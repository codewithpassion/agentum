import type { Database } from "@repo/db";
import { mailMessages } from "@repo/db/schema/mail";
import { runRequests } from "@repo/db/schema/requests";
import { MAIL_SEND_TOOL } from "@repo/db/shared";
import { and, eq, sql } from "drizzle-orm";

const MAIL_TOOL_USE_PREFIX = "mail:";

/**
 * A mail approval outlives its run and no runtime waits on it, so the request
 * and managed-run code skip it. It is the `mail_send` approval the mail
 * service opens, with a tool use id of `mail:<messageId>`.
 */
export const isMailApproval = (row: {
  toolName: string;
  toolUseId: string;
}): boolean =>
  row.toolName === MAIL_SEND_TOOL &&
  row.toolUseId.startsWith(MAIL_TOOL_USE_PREFIX);

/** The SQL twin of `isMailApproval` that keeps mail approvals out. `substr` compares case-sensitively, unlike `LIKE`. */
export const notMailApproval = sql`NOT (${runRequests.toolName} = ${MAIL_SEND_TOOL} AND substr(${runRequests.toolUseId}, 1, ${MAIL_TOOL_USE_PREFIX.length}) = ${MAIL_TOOL_USE_PREFIX})`;

/**
 * Why the mail behind an answered approval never left, or null when it did, is
 * still held, or the request is not a mail approval. An approval reads as
 * "Allowed once" the moment it is answered, and this is how its settled view
 * learns that the release failed afterwards.
 */
export const mailSendError = async (
  db: Database,
  row: { toolName: string; toolUseId: string; workspaceId: string }
): Promise<string | null> => {
  if (!isMailApproval(row)) {
    return null;
  }
  const [message] = await db
    .select({ lastError: mailMessages.lastError })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.id, row.toolUseId.slice(MAIL_TOOL_USE_PREFIX.length)),
        eq(mailMessages.workspaceId, row.workspaceId),
        eq(mailMessages.status, "failed")
      )
    );
  return message?.lastError ?? null;
};
