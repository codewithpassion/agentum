#!/usr/bin/env bun
// One-off companion to migrate-clerk-ids.ts: writes the mapping file by
// looking the old ids up on the dev Clerk instance and finding the same people
// (by email) and organisations (by name) on the production instance. Reads the
// old ids from the database. Read-only on both instances and on the database.
// Usage, from apps/web:
//   bun scripts/build-clerk-id-map.ts --out <file> --db <sqlite file> [--ignore-unresolved]
// --db is a SQLite copy of the database: `wrangler d1 export` it and load the
// dump into a file with sqlite3 or bun:sqlite.
// Keys: the dev secret key is CLERK_SECRET_KEY in .env.local, the production
// one is CLERK_SECRET_KEY in .env.production.local or CLERK_PROD_SECRET_KEY.
// An "ignore" list in the output file (ids of other systems that look like
// Clerk ids) is kept and skipped; --ignore-unresolved adds every id that does
// not resolve to it. Review that list before using the flag.
// Exits 1 when an id doesn't resolve to exactly one new id; the file still
// holds the ones that did, so fill the rest in by hand.
import { Database } from "bun:sqlite";
import { createClerkClient } from "@clerk/backend";
import { file, write } from "bun";
import { parseEnvFile } from "./agent-login-helpers.ts";
import {
  buildMapping,
  type ClerkLookup,
  discover,
  sqliteDriver,
} from "./migrate-clerk-ids-helpers.ts";

const readEnvFile = async (name: string): Promise<Record<string, string>> => {
  const envFile = file(`${import.meta.dir}/../${name}`);
  return (await envFile.exists()) ? parseEnvFile(await envFile.text()) : {};
};

const lookup = (secretKey: string): ClerkLookup => {
  const clerk = createClerkClient({ secretKey });
  return {
    emailOf: async (userId) => {
      const user = await clerk.users.getUser(userId).catch(() => undefined);
      const primary = user?.emailAddresses.find(
        (address) => address.id === user.primaryEmailAddressId
      );
      return (primary ?? user?.emailAddresses[0])?.emailAddress;
    },
    nameOf: async (orgId) =>
      (
        await clerk.organizations
          .getOrganization({ organizationId: orgId })
          .catch(() => undefined)
      )?.name,
    orgIdsByName: async (name) =>
      (
        await clerk.organizations.getOrganizationList({
          limit: 100,
          query: name,
        })
      ).data
        .filter((org) => org.name === name)
        .map((org) => org.id),
    userIdsByEmail: async (email) =>
      (await clerk.users.getUserList({ emailAddress: [email] })).data.map(
        (user) => user.id
      ),
  };
};

const main = async () => {
  const argv = process.argv.slice(2);
  const arg = (flag: string) => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const out = arg("--out");
  const dbPath = arg("--db");
  if (!(out && dbPath)) {
    throw new Error("Pass --out <file> and --db <sqlite file>.");
  }
  const driver = sqliteDriver(new Database(dbPath, { readonly: true }));

  const devKey: string | undefined = (await readEnvFile(".env.local"))
    .CLERK_SECRET_KEY;
  const prodKey: string | undefined =
    process.env.CLERK_PROD_SECRET_KEY ??
    (await readEnvFile(".env.production.local")).CLERK_SECRET_KEY;
  if (!(devKey?.startsWith("sk_test_") && prodKey?.startsWith("sk_live_"))) {
    throw new Error(
      "Need the dev key (sk_test_) as CLERK_SECRET_KEY in apps/web/.env.local and the production key (sk_live_) as CLERK_SECRET_KEY in apps/web/.env.production.local or CLERK_PROD_SECRET_KEY."
    );
  }

  // Ids already in the file's ignore list stay there, so a person can add
  // foreign ids by hand and re-run.
  const existing = file(out);
  const { ignore } = (await existing.exists())
    ? ((await existing.json()) as { ignore?: string[] })
    : { ignore: [] };

  const { occurrences } = await discover(driver);
  const { mapping, unresolved } = await buildMapping(
    occurrences.map((occurrence) => occurrence.token),
    lookup(devKey),
    lookup(prodKey),
    { ignore, ignoreUnresolved: argv.includes("--ignore-unresolved") }
  );
  await write(out, `${JSON.stringify(mapping, null, 2)}\n`);
  console.log(
    `Wrote ${Object.keys(mapping.orgs).length} org(s) and ${Object.keys(mapping.users).length} user(s) to ${out}.`
  );
  for (const line of unresolved) {
    console.error(`UNRESOLVED  ${line}`);
  }
  process.exit(unresolved.length > 0 ? 1 : 0);
};

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "build-clerk-id-map failed"
  );
  process.exit(1);
}
