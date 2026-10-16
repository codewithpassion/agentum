// Routes for checking the local setup by hand. server.ts mounts them in dev
// builds only, so a deployed Worker has none of them.
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { eq, sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
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

// Proves the Durable Object runs under the Vite plugin: the answer comes from
// inside MachineRelay.
devRoutes.get("/api/machines/ping-do", async (c) => {
  const stub = c.env.MACHINE_RELAY.get(c.env.MACHINE_RELAY.idFromName("ping"));
  return c.json(await stub.ping());
});

devRoutes.get("/api/dev/atomic-probe", async (c) => {
  const { atomic, db } = c.get("composed");
  return c.json(await runAtomicProbe(db, atomic));
});
