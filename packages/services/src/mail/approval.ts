import { runRequests } from "@repo/db/schema/requests";
import { MAIL_SEND_TOOL } from "@repo/db/shared";
import { sql } from "drizzle-orm";

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
