#!/usr/bin/env bun
// Mints a machine enrol code in the local D1 database, as the dev user, and
// prints it on stdout. Progress and errors go to stderr. Run from the repo
// root: `bun scripts/dev/enroll-token.ts [--name <machine name>]`.
import { parseArgs } from "node:util";
import type { Database } from "@repo/db";
import {
  devUserPrincipal,
  localMachines,
  openLocalDatabase,
  requireOrgId,
  runCli,
} from "./local.ts";

const DEFAULT_NAME = "dev-machine";

/** A single-use enrol code for a machine named `machineName`, valid for 15 minutes. */
export const mintEnrollCode = async ({
  db,
  machineName,
  orgId,
}: {
  db: Database;
  machineName: string;
  orgId: string;
}): Promise<string> => {
  const principal = await devUserPrincipal(db, orgId);
  const { code } = await localMachines(db, orgId).createEnrollToken(principal, {
    machineName,
  });
  return code;
};

export const main = async (argv: string[]): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: { name: { type: "string" } },
    strict: true,
  });
  const machineName = values.name ?? DEFAULT_NAME;
  const orgId = requireOrgId();
  const local = openLocalDatabase();
  process.stderr.write(`Minting an enrol code in ${local.file}.\n`);
  try {
    const code = await mintEnrollCode({
      db: local.db,
      machineName,
      orgId,
    });
    process.stdout.write(`${code}\n`);
  } finally {
    local.close();
  }
};

if (import.meta.main) {
  runCli(() => main(process.argv.slice(2)));
}
