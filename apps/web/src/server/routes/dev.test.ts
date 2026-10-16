import { expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { runAtomicProbe } from "./dev.ts";

test("the atomic probe leaves no row behind when its second statement fails", async () => {
  const db = migrated();

  const result = await runAtomicProbe(db, sqliteAtomic(db));

  expect(result).toEqual({ failed: true, firstRowPresent: false });
});
