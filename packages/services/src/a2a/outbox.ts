/**
 * Delivers the `a2a_outbox` rows: the pushes of a task's updates, the
 * activation of a paired connection, and the decline and revoke notices. A tick
 * takes the due rows, claims each one, and POSTs it through the injected
 * `A2aFetch`. A failed row backs off. The last attempt drops it with an event
 * that names no url, header, token or response body. The spec is
 * docs/v3/agent-connections.md.
 */
import type { A2aFetch } from "@repo/a2a/peer-fetch";
import type { Database } from "@repo/db";
import { a2aConnections, a2aOutbox } from "@repo/db/schema/a2a";
import { and, asc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { ForbiddenError } from "../authz.ts";
import {
  decryptSecret,
  importSecretsKey,
  type SecretBinding,
} from "../crypto.ts";
import type { EventsService } from "../events.ts";
import type { Clock } from "../runs/types.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";

/** Rows one tick takes. */
export const OUTBOX_BATCH = 50;

/** Attempts before a row is dropped. */
export const OUTBOX_MAX_ATTEMPTS = 8;

/** Delays after the nth failed attempt (n = 1..7): 1m, 5m, 15m, 1h, 3h, 6h, 12h, about 22 hours in all. */
export const OUTBOX_BACKOFF_MS: readonly number[] = [
  60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000,
];

/** How long a claimed row stays out of reach of other ticks. */
const CLAIM_MS = 5 * 60_000;

/** Rows in flight at once within one tick. */
const CONCURRENCY = 5;

/** Answers that mean the joiner will never accept an activation. */
const JOINER_REFUSALS: ReadonlySet<number> = new Set([401, 403, 404, 410]);

const headersSchema = z.record(z.string(), z.string());
const activateBodySchema = z.object({ token: z.string() });

export interface OutboxOptions {
  activation: {
    activationAbandoned: (p: Principal, connectionId: string) => Promise<void>;
    activationDelivered: (p: Principal, connectionId: string) => Promise<void>;
  };
  clock: Clock;
  db: Database;
  events: EventsService;
  /** Reaches the peer. Refuses private addresses and redirects, and dispatches in-process for our own origin. Rejects on refusal or timeout. */
  fetch: A2aFetch;
  secretsKey?: string;
}

type OutboxRow = typeof a2aOutbox.$inferSelect;
type Outcome = "delivered" | "dropped" | "retried" | "skipped";

/** Whether a row still matters, given the status of its connection. */
const matters = (kind: OutboxRow["kind"], status: string): boolean => {
  switch (kind) {
    case "push":
      return status === "active";
    case "pair_activate":
      return status === "activating";
    default:
      return true;
  }
};

/** The delay after the nth failed attempt. */
const backoffMs = (attempts: number): number => {
  const delay = OUTBOX_BACKOFF_MS[attempts - 1];
  if (delay === undefined) {
    throw new Error(`No outbox backoff after attempt ${attempts}`);
  }
  return delay;
};

export const createOutboxService = (options: OutboxOptions) => {
  const { activation, clock, db, events, secretsKey } = options;
  let importedKey: Promise<CryptoKey> | undefined;

  const unseal = async (
    binding: SecretBinding,
    stored: string
  ): Promise<string> => {
    if (!secretsKey) {
      throw new Error(
        "Reading a sealed outbox row needs secretsKey (SECRETS_KEY)."
      );
    }
    importedKey ??= importSecretsKey(secretsKey);
    return await decryptSecret(await importedKey, binding, stored);
  };

  const bindingOf = (row: OutboxRow, field: string): SecretBinding => ({
    field,
    rowId: row.id,
    table: "a2a_outbox",
    workspaceId: row.workspaceId,
  });

  /** The body and headers a row POSTs. Throws when a sealed value cannot be read. */
  const requestOf = async (
    row: OutboxRow
  ): Promise<{ body: string; headers: Record<string, string> }> => {
    const sealedHeaders =
      row.headers === null
        ? {}
        : headersSchema.parse(
            JSON.parse(await unseal(bindingOf(row, "headers"), row.headers))
          );
    const headers = {
      "A2A-Version": "1.0",
      "Content-Type": "application/json",
      ...sealedHeaders,
    };
    if (row.kind !== "pair_activate") {
      return { body: row.body, headers };
    }
    const sealedBody = activateBodySchema.parse(JSON.parse(row.body));
    const token = await unseal(bindingOf(row, "body.token"), sealedBody.token);
    return { body: JSON.stringify({ token }), headers };
  };

  /** The status the peer answered, or null when the request failed before an answer. */
  const send = async (row: OutboxRow): Promise<number | null> => {
    try {
      const { body, headers } = await requestOf(row);
      const response = await options.fetch(row.url, {
        body,
        headers,
        method: "POST",
      });
      return response.status;
    } catch {
      return null;
    }
  };

  /** Deletes the row, then records why. The event names the status only. */
  const drop = async (
    row: OutboxRow,
    agentId: string,
    attempts: number,
    reason: string
  ): Promise<Outcome> => {
    await db.delete(a2aOutbox).where(eq(a2aOutbox.id, row.id));
    await events.append({
      actor: { id: "tick", kind: "system" },
      agentId,
      payload: {
        attempts,
        connectionId: row.connectionId,
        kind: row.kind,
        reason,
      },
      type: "a2a.outbox_dropped",
      workspaceId: row.workspaceId,
    });
    if (row.kind === "pair_activate") {
      await activation.activationAbandoned(SYSTEM_PRINCIPAL, row.connectionId);
    }
    return "dropped";
  };

  /** Claims one due row and settles it. Null when another tick claimed it first. */
  const deliverRow = async (row: OutboxRow): Promise<Outcome | null> => {
    const claimed = await db
      .update(a2aOutbox)
      .set({
        nextAttemptAt: new Date(clock.now().getTime() + CLAIM_MS).toISOString(),
      })
      .where(
        and(
          eq(a2aOutbox.id, row.id),
          eq(a2aOutbox.nextAttemptAt, row.nextAttemptAt)
        )
      )
      .returning({ id: a2aOutbox.id });
    if (claimed.length === 0) {
      return null;
    }

    const [connection] = await db
      .select({
        localAgentId: a2aConnections.localAgentId,
        status: a2aConnections.status,
      })
      .from(a2aConnections)
      .where(eq(a2aConnections.id, row.connectionId))
      .limit(1);
    if (!(connection && matters(row.kind, connection.status))) {
      await db.delete(a2aOutbox).where(eq(a2aOutbox.id, row.id));
      return "skipped";
    }

    const status = await send(row);
    const attempts = row.attempts + 1;
    if (status !== null && status >= 200 && status < 300) {
      await db.delete(a2aOutbox).where(eq(a2aOutbox.id, row.id));
      if (row.kind === "pair_activate") {
        await activation.activationDelivered(
          SYSTEM_PRINCIPAL,
          row.connectionId
        );
      }
      return "delivered";
    }
    if (
      row.kind === "pair_activate" &&
      status !== null &&
      JOINER_REFUSALS.has(status)
    ) {
      return await drop(
        row,
        connection.localAgentId,
        attempts,
        `status ${status}`
      );
    }
    if (attempts >= OUTBOX_MAX_ATTEMPTS) {
      return await drop(row, connection.localAgentId, attempts, "exhausted");
    }
    await db
      .update(a2aOutbox)
      .set({
        attempts,
        nextAttemptAt: new Date(
          clock.now().getTime() + backoffMs(attempts)
        ).toISOString(),
      })
      .where(eq(a2aOutbox.id, row.id));
    return "retried";
  };

  /** `deliverRow` that never throws. A row that throws keeps its claim and is retried after it. */
  const settle = async (row: OutboxRow): Promise<Outcome | null> => {
    try {
      return await deliverRow(row);
    } catch (error) {
      console.error(
        "A2A outbox row not settled",
        row.id,
        error instanceof Error ? error.name : "unknown"
      );
      return null;
    }
  };

  /** One tick: delivers the due rows, oldest first, up to `OUTBOX_BATCH`. */
  const deliverDue = async (
    principal: Principal
  ): Promise<Record<Outcome, number>> => {
    if (principal.kind !== "system") {
      throw new ForbiddenError("a2a.outbox.deliverDue");
    }
    const due = await db
      .select()
      .from(a2aOutbox)
      .where(lte(a2aOutbox.nextAttemptAt, clock.now().toISOString()))
      .orderBy(asc(a2aOutbox.nextAttemptAt), asc(a2aOutbox.id))
      .limit(OUTBOX_BATCH);
    const tally: Record<Outcome, number> = {
      delivered: 0,
      dropped: 0,
      retried: 0,
      skipped: 0,
    };
    for (let start = 0; start < due.length; start += CONCURRENCY) {
      const chunk = due.slice(start, start + CONCURRENCY);
      // biome-ignore lint/performance/noAwaitInLoops: chunks run one after another, which caps the rows in flight
      const outcomes = await Promise.all(chunk.map(settle));
      for (const outcome of outcomes) {
        if (outcome) {
          tally[outcome] += 1;
        }
      }
    }
    return tally;
  };

  return { deliverDue };
};

export type OutboxService = ReturnType<typeof createOutboxService>;
