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
 * Pass writes only. Use `returning()` to capture rows through `onResults`.
 * Do not await it or call `.run()`: `atomic` does that.
 */
export type Statement = BatchItem<"sqlite"> & {
  run: () => unknown;
  all: () => unknown;
};

/**
 * Runs all statements or none, in order. Optional results are delivered after commit.
 * If `onResults` throws, `atomic` rejects after the writes have committed.
 */
export type Atomic = (
  statements: readonly Statement[],
  onResults?: (results: unknown[]) => void
) => Promise<void>;

/**
 * D1: one `db.batch`, which D1 runs as a single transaction.
 * If `onResults` throws, `atomic` rejects after the writes have committed.
 */
export const d1Atomic =
  (db: Pick<DrizzleD1Database, "batch">): Atomic =>
  async (statements, onResults) => {
    // D1 rejects an empty batch, and the type wants a non-empty tuple.
    const [first, ...rest] = statements;
    if (first) {
      const results = await db.batch([first, ...rest]);
      onResults?.(results);
    }
  };

/**
 * bun:sqlite: one `db.transaction`, rolled back if a statement throws.
 * `run()` executes synchronously, which a sync transaction callback needs.
 * If `onResults` throws, `atomic` rejects after the writes have committed.
 */
export const sqliteAtomic =
  (db: { transaction: (fn: () => void) => unknown }): Atomic =>
  (statements, onResults) => {
    try {
      const results: unknown[] = [];
      db.transaction(() => {
        for (const statement of statements) {
          if (onResults) {
            results.push(statement.all());
          } else {
            statement.run();
          }
        }
      });
      onResults?.(results);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  };
