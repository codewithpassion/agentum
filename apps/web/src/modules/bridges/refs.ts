import { and, eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { externalRefs } from "./schema";
import type { ExternalRefInput } from "./types";

/** Both directions of the external ↔ internal mapping, in one place. */

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
