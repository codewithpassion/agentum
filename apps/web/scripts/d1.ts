import { $ } from "bun";
import { DEFAULT_WORKSPACE_ID } from "#/modules/workspaces/service";

/**
 * The local D1 database, reached the way the dev server reaches it: through
 * wrangler's `DB` binding, against `.wrangler/state`. Remote is deliberately
 * not an option here - no remote database has been provisioned yet (see
 * wrangler.jsonc).
 *
 * `wrangler d1 execute` cannot bind parameters, so every value a script
 * interpolates has to go through `sqlValue`.
 */

interface D1Response<Row> {
  results: Row[];
  success: boolean;
}

/** A SQL string literal, with embedded quotes doubled. */
export const sqlValue = (value: string | null): string =>
  value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;

export const d1Execute = async <Row>(command: string): Promise<Row[]> => {
  const output =
    await $`bunx wrangler d1 execute DB --local --json --command ${command}`
      .quiet()
      .text();
  const responses = JSON.parse(output) as D1Response<Row>[];
  return responses.flatMap((response) => response.results);
};

/**
 * Both scripts write to `workspace_members`, which migration 0012 creates -
 * without it they would fail deep inside wrangler with a "no such table".
 */
export const requireDefaultWorkspace = async (): Promise<void> => {
  const rows = await d1Execute<{ id: string }>(
    `SELECT id FROM workspaces WHERE id = ${sqlValue(DEFAULT_WORKSPACE_ID)}`
  ).catch(() => []);
  if (rows.length === 0) {
    throw new Error(
      "No default workspace in the local database. Run `bun run db:migrate:local` first."
    );
  }
};
