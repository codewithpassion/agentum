// Routes for checking the local setup by hand. server.ts mounts them in dev
// builds only, so a deployed Worker has none of them.
import { createClerkClient } from "@clerk/backend";
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import type { MachineRelayPort } from "@repo/services/machines/types";
import type { RunsService } from "@repo/services/runs";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { eq, sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { z } from "zod";
import { durableRelayPort } from "../relay-port.ts";
import type { AppEnv } from "./groups.ts";

// A scratch table the probe creates for itself, so it needs no migration.
const atomicProbe = sqliteTable("atomic_probe", { id: text().primaryKey() });

/**
 * Runs a two-statement `atomic` whose second statement fails (same primary
 * key as the first), then looks for the first row. `firstRowPresent` must be
 * false: the failed write rolled back as a whole.
 */
export const runAtomicProbe = async (db: Database, atomic: Atomic) => {
  await db.run(
    sql`CREATE TABLE IF NOT EXISTS atomic_probe (id TEXT PRIMARY KEY)`
  );
  const id = crypto.randomUUID();
  let failed = false;
  try {
    await atomic([
      db.insert(atomicProbe).values({ id }),
      db.insert(atomicProbe).values({ id }),
    ]);
  } catch {
    failed = true;
  }
  const rows = await db
    .select()
    .from(atomicProbe)
    .where(eq(atomicProbe.id, id));
  return { failed, firstRowPresent: rows.length > 0 };
};

export const devRoutes = new Hono<AppEnv>();

devRoutes.get("/api/dev/atomic-probe", async (c) => {
  const { atomic, db } = c.get("composed");
  return c.json(await runAtomicProbe(db, atomic));
});

const offerBodySchema = z.strictObject({
  agentId: z.string().min(1),
  machineId: z.string().min(1),
  runId: z.string().min(1),
});

const BAD_REQUEST = 400;

/**
 * Tells the machine's relay to offer a run, as the minute sweep would after a
 * minute. `scripts/e2e/skeleton.ts` writes its runs straight into the local
 * database, so nothing else would offer them to the connected daemon.
 */
export const offerRunToRelay = async (
  relay: MachineRelayPort,
  body: unknown
): Promise<{ ok: boolean }> => {
  const parsed = offerBodySchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false };
  }
  const { agentId, machineId, runId } = parsed.data;
  await relay.offer(machineId, { agentId, runId });
  return { ok: true };
};

devRoutes.post("/api/dev/offer", async (c) => {
  const body = await c.req.json().catch(() => null);
  const result = await offerRunToRelay(
    durableRelayPort(c.env.MACHINE_RELAY),
    body
  );
  return result.ok
    ? c.json({})
    : c.json({ error: "Expected agentId, machineId and runId." }, BAD_REQUEST);
});

const CLOUD_ACTIONS = ["cancel", "offer", "redispatch"] as const;
const cloudBodySchema = z.strictObject({ runId: z.string().min(1) });

/**
 * Drives a cloud run by hand, as the system. `offer` is what the minute sweep
 * does for a queued run. `redispatch` puts a running run back and offers it
 * again, which is what a start that looked failed does (the Durable Object got
 * the run, the call to it threw), so the object sees the same run twice.
 * `cancel` is the cancel button. `scripts/e2e/cloud.ts` uses all three.
 */
export const driveCloudRun = async (
  runs: Pick<RunsService, "cancelRun" | "offerQueuedRun" | "releaseRun">,
  action: string,
  body: unknown
): Promise<{ ok: boolean }> => {
  const parsed = cloudBodySchema.safeParse(body);
  if (!(parsed.success && CLOUD_ACTIONS.some((known) => known === action))) {
    return { ok: false };
  }
  const { runId } = parsed.data;
  if (action === "cancel") {
    await runs.cancelRun(SYSTEM_PRINCIPAL, runId);
  } else {
    if (action === "redispatch") {
      await runs.releaseRun(SYSTEM_PRINCIPAL, runId);
    }
    await runs.offerQueuedRun(SYSTEM_PRINCIPAL, runId);
  }
  return { ok: true };
};

devRoutes.post("/api/dev/cloud/:action", async (c) => {
  const body = await c.req.json().catch(() => null);
  const result = await driveCloudRun(
    c.get("composed").services.runs,
    c.req.param("action"),
    body
  );
  return result.ok
    ? c.json({})
    : c.json(
        { error: "Expected a runId and cancel, offer or redispatch." },
        BAD_REQUEST
      );
});

// One-click dev login: mints a one-time Clerk sign-in token for the dev user
// and hands it to /dev-login to redeem client-side. Only active when
// DEV_LOGIN_EMAIL is configured, which must never be set in a deployed
// environment. The route is mounted in dev builds only (server.ts), so a
// deployed Worker has none, whatever its env holds. It also makes the dev
// organisation's workspace row.
devRoutes.get("/api/dev-login", async (c) => {
  const email = c.env.DEV_LOGIN_EMAIL;
  if (!email) {
    return c.text("Dev login is not configured.", 404);
  }

  const clerkClient = createClerkClient({ secretKey: c.env.CLERK_SECRET_KEY });
  const { data } = await clerkClient.users.getUserList({
    emailAddress: [email],
  });
  const [user] = data;
  if (!user) {
    return c.text(
      `Dev login user ${email} does not exist yet. Run "bun run create-dev-user" in apps/web.`,
      404
    );
  }

  const { data: memberships } =
    await clerkClient.users.getOrganizationMembershipList({ userId: user.id });
  const [membership] = memberships;
  if (!membership) {
    return c.text(
      `Dev login user ${email} has no organisation yet. Run "bun run create-dev-user" in apps/web.`,
      404
    );
  }

  // A workspace row is what admits an organisation. A clean `.wrangler` has
  // none, so the dev login makes the one for the dev organisation.
  await c.get("composed").services.workspaces.create({
    clerkOrgId: membership.organization.id,
    name: membership.organization.name,
  });

  const { token } = await clerkClient.signInTokens.createSignInToken({
    expiresInSeconds: 60,
    userId: user.id,
  });

  return c.redirect(
    `/dev-login?token=${encodeURIComponent(token)}&org=${encodeURIComponent(membership.organization.id)}`
  );
});
