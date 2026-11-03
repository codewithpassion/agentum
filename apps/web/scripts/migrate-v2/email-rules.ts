#!/usr/bin/env bun
// Points the agent mailboxes' Email Routing rules at the new Worker
// (docs/v3/agentum-v2-cutover.md). Each mailbox has one rule in the
// rockyshoreslabs.io zone whose action names the Worker, and changing
// MAIL_WORKER_NAME does not touch rules that exist. Dry run unless --apply.
// Usage, from apps/web:
//   CF_EMAIL_ROUTING_TOKEN=... bun scripts/migrate-v2/email-rules.ts --env staging|production [--apply]
// The token needs Zone > Email Routing Rules > Edit on the zone (the Worker's
// own CF_EMAIL_ROUTING_TOKEN has it). Rules are picked by the Worker they
// deliver to, never by name, because both environments share the zone.
import {
  NAMES,
  parseMoveArgs,
  type RoutingRule,
  repointedRule,
  rulesForWorker,
} from "./helpers.ts";

const ZONE_ID = "4dd028fe52d70f89e51383e1689d601a";
const RULES_URL = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules`;

interface Envelope<T> {
  errors: { message: string }[];
  result: T;
  result_info?: { total_pages?: number };
  success: boolean;
}

const call = async <T>(token: string, url: string, init: RequestInit = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  const body = (await response.json()) as Envelope<T>;
  if (!body.success) {
    const text = body.errors.map((error) => error.message).join("; ");
    throw new Error(`Email Routing ${response.status}: ${text || "failed"}`);
  }
  return body;
};

const listRules = async (token: string): Promise<RoutingRule[]> => {
  const rules: RoutingRule[] = [];
  for (let page = 1; ; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each page says whether there is another
    const body = await call<RoutingRule[]>(
      token,
      `${RULES_URL}?page=${page}&per_page=50`
    );
    rules.push(...body.result);
    const pages = body.result_info?.total_pages;
    if (pages === undefined ? body.result.length < 50 : page >= pages) {
      return rules;
    }
  }
};

const main = async () => {
  const { apply, env } = parseMoveArgs(process.argv.slice(2));
  const token = process.env.CF_EMAIL_ROUTING_TOKEN;
  if (!token) {
    throw new Error("Set CF_EMAIL_ROUTING_TOKEN.");
  }
  const { oldWorker, newWorker } = NAMES[env];
  const rules = rulesForWorker(await listRules(token), oldWorker);
  console.log(`${rules.length} rules deliver to ${oldWorker}:`);
  for (const rule of rules) {
    console.log(`  ${rule.id} ${rule.name ?? ""}`);
  }
  if (!apply) {
    console.log(`Dry run. --apply points them at ${newWorker}.`);
    return;
  }
  for (const rule of rules) {
    // biome-ignore lint/performance/noAwaitInLoops: one rule at a time, so a failure stops the run where it is
    await call(token, `${RULES_URL}/${encodeURIComponent(rule.id)}`, {
      body: JSON.stringify(repointedRule(rule, newWorker)),
      method: "PUT",
    });
  }
  const left = rulesForWorker(await listRules(token), oldWorker);
  if (left.length > 0) {
    throw new Error(`${left.length} rules still deliver to ${oldWorker}.`);
  }
  console.log(`Pointed ${rules.length} rules at ${newWorker}.`);
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "email rules failed");
  process.exit(1);
}
