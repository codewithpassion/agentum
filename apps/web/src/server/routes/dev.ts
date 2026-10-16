// Routes for checking the local setup by hand. server.ts mounts them in dev
// builds only, so a deployed Worker has none of them.
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import type { MachineRelayPort } from "@repo/services/machines/types";
import { eq, sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { z } from "zod";
import { durableRelayPort } from "../relay-port.ts";
import type { AppEnv } from "./groups.ts";

// A scratch table the probe creates for itself, so it needs no migration.
const atomicProbe = sqliteTable("atomic_probe", { id: text().primaryKey() });

/**
 * Runs a two-statement `atomic` whose second statement fails (same primary
 * key as the first), then looks for the first row. `firstRowPresent` must be
 * false: the failed write rolled back as a whole.
 */
export const runAtomicProbe = async (db: Database, atomic: Atomic) => {
  await db.run(
    sql`CREATE TABLE IF NOT EXISTS atomic_probe (id TEXT PRIMARY KEY)`
  );
  const id = crypto.randomUUID();
  let failed = false;
  try {
    await atomic([
      db.insert(atomicProbe).values({ id }),
      db.insert(atomicProbe).values({ id }),
    ]);
  } catch {
    failed = true;
  }
  const rows = await db
    .select()
    .from(atomicProbe)
    .where(eq(atomicProbe.id, id));
  return { failed, firstRowPresent: rows.length > 0 };
};

export const devRoutes = new Hono<AppEnv>();

devRoutes.get("/api/dev/atomic-probe", async (c) => {
  const { atomic, db } = c.get("composed");
  return c.json(await runAtomicProbe(db, atomic));
});

const offerBodySchema = z.strictObject({
  agentId: z.string().min(1),
  machineId: z.string().min(1),
  runId: z.string().min(1),
});

const BAD_REQUEST = 400;

/**
 * Tells the machine's relay to offer a run, as the minute sweep would after a
 * minute. `scripts/e2e/skeleton.ts` writes its runs straight into the local
 * database, so nothing else would offer them to the connected daemon.
 */
export const offerRunToRelay = async (
  relay: MachineRelayPort,
  body: unknown
): Promise<{ ok: boolean }> => {
  const parsed = offerBodySchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false };
  }
  const { agentId, machineId, runId } = parsed.data;
  await relay.offer(machineId, { agentId, runId });
  return { ok: true };
};

devRoutes.post("/api/dev/offer", async (c) => {
  const body = await c.req.json().catch(() => null);
  const result = await offerRunToRelay(
    durableRelayPort(c.env.MACHINE_RELAY),
    body
  );
  return result.ok
    ? c.json({})
    : c.json({ error: "Expected agentId, machineId and runId." }, BAD_REQUEST);
});
