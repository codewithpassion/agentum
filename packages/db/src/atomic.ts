// The one port for multi-statement writes. drizzle 0.44 has `batch` only on the
// D1 driver and interactive transactions only on the SQLite drivers, and D1
// has no interactive transactions at all. So there are two adapters behind one
// type: the app passes `d1Atomic(drizzle(env.DB))`, tests pass
// `sqliteAtomic(drizzle(new Sqlite(":memory:")))`, and services take it as a
// parameter. Every "in one atomic write" in the docs means a call to this.
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";

/**
 * An unexecuted insert, update or delete, e.g. `db.insert(runs).values(row)`.
 * Pass writes only. A select would type-check, but its rows are discarded.
 * Do not await it or call `.run()`: `atomic` does that.
 */
export type Statement = BatchItem<"sqlite"> & { run: () => unknown };

/** Runs all statements or none, in order. Rejects if any of them fails. */
export type Atomic = (statements: readonly Statement[]) => Promise<void>;

/** D1: one `db.batch`, which D1 runs as a single transaction. */
export const d1Atomic =
  (db: Pick<DrizzleD1Database, "batch">): Atomic =>
  async (statements) => {
    // D1 rejects an empty batch, and the type wants a non-empty tuple.
    const [first, ...rest] = statements;
    if (first) {
      await db.batch([first, ...rest]);
    }
  };

/**
 * bun:sqlite: one `db.transaction`, rolled back if a statement throws.
 * `run()` executes synchronously, which a sync transaction callback needs.
 */
export const sqliteAtomic =
  (db: { transaction: (fn: () => void) => unknown }): Atomic =>
  (statements) => {
    try {
      db.transaction(() => {
        for (const statement of statements) {
          statement.run();
        }
      });
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  };
