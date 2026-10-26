import { expect, test } from "bun:test";
import { file } from "bun";
import { EVENT_TYPES } from "./shared.ts";
import { migrated } from "./test-db.ts";

const IMPORT_STATEMENT = /^\s*import\s|\sfrom\s+["']/m;

test("the desk indexes exist on runs after a fresh migration", () => {
  const { client } = migrated();
  const indexes = client
    .query<{ name: string }, []>("PRAGMA index_list(runs)")
    .all()
    .map((row) => row.name);
  expect(indexes).toContain("runs_workspace_status_idx");
  expect(indexes).toContain("runs_workspace_finished_idx");
  expect(indexes).toContain("runs_agent_status_idx");

  const columns = (index: string) =>
    client
      .query<{ name: string }, []>(`PRAGMA index_info(${index})`)
      .all()
      .map((row) => row.name);
  expect(columns("runs_workspace_status_idx")).toEqual([
    "workspace_id",
    "status",
  ]);
  expect(columns("runs_workspace_finished_idx")).toEqual([
    "workspace_id",
    "finished_at",
  ]);
  expect(columns("runs_agent_status_idx")).toEqual(["agent_id", "status"]);
});

test("the shared module has no imports, so no drizzle reaches the browser", async () => {
  const source = await file(new URL("./shared.ts", import.meta.url)).text();
  expect(source).not.toMatch(IMPORT_STATEMENT);
});

test("message.reasoning is a known event type", () => {
  expect(EVENT_TYPES).toContain("message.reasoning");
});
