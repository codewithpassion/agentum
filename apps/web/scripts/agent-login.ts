#!/usr/bin/env bun
// Prints a one-time Clerk Agent Task URL that signs a user in on the chosen
// environment, with no sign-in screen. The URL is a credential: print it to
// stdout only. Usage: bun run agent-login [--env local|staging|preview|production]
// [--pr <n>] [--email <address>] [--redirect <path>] [--base-url <url>]
import { createClerkClient } from "@clerk/backend";
import { file } from "bun";
import {
  parseArgs,
  parseEnvFile,
  redirectUrlFor,
  resolveSecretKey,
} from "./agent-login-helpers.ts";

const readEnvFile = async (name: string): Promise<Record<string, string>> => {
  const envFile = file(`${import.meta.dir}/../${name}`);
  return (await envFile.exists()) ? parseEnvFile(await envFile.text()) : {};
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const envLocal = await readEnvFile(".env.local");
  const secretKey = resolveSecretKey(args.env, {
    envLocal,
    process: process.env,
    productionLocal: await readEnvFile(".env.production.local"),
  });

  const email = args.email ?? envLocal.DEV_LOGIN_EMAIL;
  if (!email) {
    throw new Error(
      "Pass --email, or set DEV_LOGIN_EMAIL in apps/web/.env.local"
    );
  }

  const clerkClient = createClerkClient({ secretKey });
  const agentTask = await clerkClient.agentTasks.create({
    agentName: "agentum-agent-login",
    onBehalfOf: { identifier: email },
    permissions: "*",
    redirectUrl: redirectUrlFor(args),
    taskDescription: `Sign in as ${email} on ${args.env}`,
  });
  console.log(agentTask.url);
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "agent-login failed");
  process.exit(1);
}
