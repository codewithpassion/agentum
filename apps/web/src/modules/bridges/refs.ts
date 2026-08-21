import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { externalRefs } from "./schema";
import type { ExternalRefInput } from "./types";

/** Both directions of the external ↔ internal mapping, in one place. */

/** D1 binds no more parameters than this to one statement. */
const MAX_IDS_PER_STATEMENT = 100;

export const recordExternalRef = async (
  db: Db,
  connector: string,
  ref: ExternalRefInput
): Promise<void> => {
  await db
    .insert(externalRefs)
    .values({
      connector,
      externalId: ref.externalId,
      id: crypto.randomUUID(),
      internalId: ref.internalId,
      internalType: ref.internalType,
    })
    .onConflictDoNothing();
};

/**
 * The refs pointing at messages that are being deleted. `external_refs` has no
 * workspace of its own - it is a bridge-scoped lookup - so the workspace-delete
 * cleanup names the messages instead, and passes them in a statement at a time.
 */
export const deleteExternalRefsForMessages = async (
  db: Db,
  messageIds: readonly string[]
): Promise<void> => {
  for (
    let start = 0;
    start < messageIds.length;
    start += MAX_IDS_PER_STATEMENT
  ) {
    const batch = messageIds.slice(start, start + MAX_IDS_PER_STATEMENT);
    // biome-ignore lint/performance/noAwaitInLoops: statements are paced, not fanned out at D1
    await db
      .delete(externalRefs)
      .where(
        and(
          eq(externalRefs.internalType, "message"),
          inArray(externalRefs.internalId, [...batch])
        )
      );
  }
};

/** External id → internal id (e.g. a Slack `channel:ts` → our message id). */
export const findInternalId = async (
  db: Db,
  connector: string,
  internalType: ExternalRefInput["internalType"],
  externalId: string
): Promise<string | undefined> => {
  const [row] = await db
    .select({ internalId: externalRefs.internalId })
    .from(externalRefs)
    .where(
      and(
        eq(externalRefs.connector, connector),
        eq(externalRefs.internalType, internalType),
        eq(externalRefs.externalId, externalId)
      )
    );
  return row?.internalId;
};

/** Internal id → external id, the direction threading a mirrored reply needs. */
export const findExternalId = async (
  db: Db,
  connector: string,
  internalType: ExternalRefInput["internalType"],
  internalId: string
): Promise<string | undefined> => {
  const [row] = await db
    .select({ externalId: externalRefs.externalId })
    .from(externalRefs)
    .where(
      and(
        eq(externalRefs.connector, connector),
        eq(externalRefs.internalType, internalType),
        eq(externalRefs.internalId, internalId)
      )
    );
  return row?.externalId;
};
