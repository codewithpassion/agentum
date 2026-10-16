import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { openSqlite } from "./local.ts";

const HOLD_MS = 600;

// Holds a write lock in a child process, since a blocked write in this process
// would also block anything here that could release the lock.
const HOLDER = `
import { Database } from "bun:sqlite";
const db = new Database(process.argv[1]);
db.run("BEGIN IMMEDIATE");
db.run("INSERT INTO t VALUES (1)");
console.log("locked");
await Bun.sleep(${HOLD_MS});
db.run("COMMIT");
`;

test("a write through openSqlite waits for another connection's write lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "local-busy-"));
  const file = join(dir, "db.sqlite");
  const setup = openSqlite(file);
  setup.run("CREATE TABLE t (id INTEGER)");
  setup.close();

  const holder = spawn(["bun", "-e", HOLDER, file], { stdout: "pipe" });
  try {
    const reader = holder.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("locked");

    const client = openSqlite(file);
    const started = performance.now();
    client.run("INSERT INTO t VALUES (2)");
    const waited = performance.now() - started;
    client.close();

    expect(waited).toBeGreaterThan(HOLD_MS / 4);
    await holder.exited;
    const check = openSqlite(file);
    expect(check.query("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 2 });
    check.close();
  } finally {
    holder.kill();
    rmSync(dir, { force: true, recursive: true });
  }
});
