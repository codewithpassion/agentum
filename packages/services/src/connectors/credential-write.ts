/**
 * The write half of storing a credential, shared by a pasted header value and
 * an OAuth grant. A credential is one row per (connector, owner). The first
 * write inserts it at `version = 1`. Any later write for the same owner
 * replaces the secret and bumps `version`, behind a version fence: a write that
 * read an older version changes nothing and reports a conflict. A replaced
 * credential is `ok` again and holds no refresh lease.
 */
import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { credentials } from "@repo/db/schema/connectors";
import type { CredentialOwnerKind } from "@repo/db/shared";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { isUniqueViolation, ServiceError } from "../errors.ts";

export interface CredentialOwner {
  id: string;
  kind: CredentialOwnerKind;
}

/** Where the credential for one owner lives. `version` is null before the first write. */
export interface CredentialSlot {
  id: string;
  version: number | null;
}

const conflictOnSave = (): ServiceError =>
  new ServiceError(
    "conflict",
    "A credential was just saved for this owner, try again"
  );

/**
 * The existing row for this owner, or a new id. Read before encrypting,
 * because the secret is bound to the row id.
 */
export const findCredentialSlot = async (
  db: Database,
  connectorId: string,
  owner: CredentialOwner,
  nowMs: number
): Promise<CredentialSlot> => {
  const [existing] = await db
    .select({ id: credentials.id, version: credentials.version })
    .from(credentials)
    .where(
      and(
        eq(credentials.connectorId, connectorId),
        eq(credentials.ownerKind, owner.kind),
        eq(credentials.ownerId, owner.id)
      )
    )
    .limit(1);
  return existing
    ? { id: existing.id, version: existing.version }
    : { id: ulid(nowMs), version: null };
};

export const writeCredential = async (
  { atomic, db }: { atomic: Atomic; db: Database },
  input: {
    /** A write that lands with a first insert, and right after a replacement. */
    alongside?: Statement;
    connectorId: string;
    createdBy: string;
    expiresAt: string | null;
    /** ISO time of the write. */
    now: string;
    owner: CredentialOwner;
    scopes: string | null;
    /** Already encrypted for `slot.id`. */
    secret: string;
    slot: CredentialSlot;
    workspaceId: string;
  }
): Promise<void> => {
  const { slot } = input;
  try {
    if (slot.version !== null) {
      const replaced = await db
        .update(credentials)
        .set({
          expiresAt: input.expiresAt,
          refreshingUntil: null,
          scopes: input.scopes,
          secret: input.secret,
          status: "ok",
          updatedAt: input.now,
          version: slot.version + 1,
        })
        .where(
          and(
            eq(credentials.id, slot.id),
            eq(credentials.version, slot.version)
          )
        )
        .returning({ id: credentials.id });
      if (replaced.length === 0) {
        throw conflictOnSave();
      }
      await input.alongside;
      return;
    }
    await atomic([
      db.insert(credentials).values({
        connectorId: input.connectorId,
        createdAt: input.now,
        createdBy: input.createdBy,
        expiresAt: input.expiresAt,
        id: slot.id,
        ownerId: input.owner.id,
        ownerKind: input.owner.kind,
        scopes: input.scopes,
        secret: input.secret,
        status: "ok",
        updatedAt: input.now,
        version: 1,
        workspaceId: input.workspaceId,
      }),
      ...(input.alongside ? [input.alongside] : []),
    ]);
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      throw conflictOnSave();
    }
    throw error;
  }
};
