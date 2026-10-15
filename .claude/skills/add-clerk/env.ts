#!/usr/bin/env bun
/**
 * Edits apps/web/.env.local for the add-clerk skill without printing a
 * secret. Commands:
 *
 *   sync               give CLERK_PUBLISHABLE_KEY and VITE_CLERK_PUBLISHABLE_KEY
 *                      the same value and report each Clerk key's prefix
 *   dev-login <email>  set DEV_LOGIN_EMAIL and a generated DEV_LOGIN_PASSWORD
 */
import { $, file, write } from "bun";

const PREFIX_LENGTH = "pk_test_".length;
const CLERK_KEYS = [
  "VITE_CLERK_PUBLISHABLE_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
] as const;

const root = (await $`git rev-parse --show-toplevel`.text()).trim();
const envPath = `${root}/apps/web/.env.local`;
const envFile = file(envPath);
if (!(await envFile.exists())) {
  console.error(`${envPath} does not exist. Copy apps/web/.env.example first.`);
  process.exit(1);
}
let text = await envFile.text();

const get = (key: string): string =>
  text.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1].trim() ?? "";

const set = (key: string, value: string) => {
  const line = `${key}=${value}`;
  const existing = new RegExp(`^${key}=.*$`, "m");
  text = existing.test(text)
    ? text.replace(existing, line)
    : `${text.trimEnd()}\n${line}\n`;
};

const usage = () => {
  console.error(
    "usage: bun .claude/skills/add-clerk/env.ts sync | dev-login <email>"
  );
  process.exit(1);
};

const [, , command, email] = process.argv;

if (command === "sync") {
  const publishable =
    get("VITE_CLERK_PUBLISHABLE_KEY") || get("CLERK_PUBLISHABLE_KEY");
  if (!publishable) {
    console.error(
      "No publishable key in .env.local. Run `clerk env pull` first."
    );
    process.exit(1);
  }
  if (!get("CLERK_SECRET_KEY")) {
    console.error(
      "No CLERK_SECRET_KEY in .env.local. Run `clerk env pull` first."
    );
    process.exit(1);
  }
  set("VITE_CLERK_PUBLISHABLE_KEY", publishable);
  set("CLERK_PUBLISHABLE_KEY", publishable);
  await write(envPath, text);
  for (const key of CLERK_KEYS) {
    console.log(`${key}=${get(key).slice(0, PREFIX_LENGTH)}…`);
  }
} else if (command === "dev-login" && email) {
  set("DEV_LOGIN_EMAIL", email);
  set("DEV_LOGIN_PASSWORD", crypto.randomUUID());
  await write(envPath, text);
  console.log(`DEV_LOGIN_EMAIL=${email}\nDEV_LOGIN_PASSWORD=<generated>`);
} else {
  usage();
}
