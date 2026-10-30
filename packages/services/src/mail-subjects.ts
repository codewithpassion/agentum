/**
 * The mail subject that titles a run started by mail, read from the database.
 * The pure title text is in `mail-title-text.ts`.
 */
import type { Database } from "@repo/db";
import { mailMessages } from "@repo/db/schema/mail";
import { and, eq, inArray } from "drizzle-orm";
import { inBatches } from "./tasks/reads.ts";

/**
 * The inbound mail subject of each run, keyed by run id, read in batches. A run
 * with no inbound mail message has no entry.
 */
export const mailSubjectsOf = async (
  db: Database,
  workspaceId: string,
  runIds: readonly string[]
): Promise<Map<string, string>> => {
  const found = await inBatches(runIds, (batch) =>
    db
      .select({ runId: mailMessages.runId, subject: mailMessages.subject })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.workspaceId, workspaceId),
          eq(mailMessages.direction, "in"),
          inArray(mailMessages.runId, batch)
        )
      )
  );
  const subjects = new Map<string, string>();
  for (const { runId, subject } of found) {
    if (runId !== null && !subjects.has(runId)) {
      subjects.set(runId, subject);
    }
  }
  return subjects;
};
