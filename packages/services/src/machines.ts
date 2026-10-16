/**
 * Machines: enrol tokens, machine credentials, presence and revoke. A user
 * mints a single-use `hm_enr_` code, the daemon trades it for a long-lived
 * `hm_mach_` credential (stored only as a hash), and the machine's relay
 * keeps `status` and `last_seen_at` current. The relay acts as the machine it
 * hosts: it passes that machine's principal to the presence methods.
 */
import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { machineEnrollTokens, machines } from "@repo/db/schema/machines";
import { runs } from "@repo/db/schema/runs";
import { workspaces } from "@repo/db/schema/workspaces";
import type { MachineStatus } from "@repo/db/shared";
import { and, asc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { authorize, ForbiddenError } from "./authz.ts";
import { hashedToken, hashToken } from "./crypto.ts";
import { ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import type { MachineRelayPort } from "./machines/types.ts";
import type { Clock } from "./runs/types.ts";
import {
  bearerToken,
  findMachineByCredential,
  type Principal,
} from "./workspaces.ts";

export const ENROLL_TOKEN_PREFIX = "hm_enr_";
export const MACHINE_CREDENTIAL_PREFIX = "hm_mach_";
/** Long enough to paste the command onto a machine, short enough to matter. */
export const ENROLL_TTL_MS = 15 * 60 * 1000;
/** Runs one `hello` offers at most. The minute sweep offers the rest. */
export const OFFER_BATCH = 200;

const MACHINE_KIND = "machine";
const ENROLL_ACTION = "machines.enroll";
const READ_ACTION = "machines.read";
const REVOKE_ACTION = "machines.revoke";
const PRESENCE_ACTION = "machines.presence";

type UserPrincipal = Extract<Principal, { kind: "user" }>;
export type MachinePrincipal = Extract<Principal, { kind: "machine" }>;

export const enrollTokenInputSchema = z.strictObject({
  machineName: z.string().trim().min(1).max(80),
});
export type EnrollTokenInput = z.input<typeof enrollTokenInputSchema>;

export const enrollInputSchema = z.strictObject({
  code: z.string().startsWith(ENROLL_TOKEN_PREFIX).max(200),
  singleUser: z.boolean(),
});
export type EnrollInput = z.input<typeof enrollInputSchema>;

/** A machine row as the services hand it out. Never carries the credential hash. */
export interface MachineRecord {
  capabilities: Record<string, unknown>;
  createdAt: string;
  enrolledBy: string;
  id: string;
  lastSeenAt: string | null;
  name: string;
  singleUser: boolean;
  status: MachineStatus;
  workspaceId: string;
}

type MachineRow = typeof machines.$inferSelect;

const capabilitiesSchema = z.record(z.string(), z.json());

const toRecord = (row: MachineRow): MachineRecord => ({
  capabilities: capabilitiesSchema.parse(JSON.parse(row.capabilities)),
  createdAt: row.createdAt,
  enrolledBy: row.enrolledBy,
  id: row.id,
  lastSeenAt: row.lastSeenAt,
  name: row.name,
  singleUser: row.singleUser,
  status: row.status,
  workspaceId: row.workspaceId,
});

const requireUser = (principal: Principal, action: string): UserPrincipal => {
  if (principal.kind !== "user") {
    throw new ForbiddenError(action);
  }
  return principal;
};

const requireMachine = (
  principal: Principal,
  action: string
): MachinePrincipal => {
  if (principal.kind !== "machine") {
    throw new ForbiddenError(action);
  }
  return principal;
};

export const createMachinesService = ({
  allowedOrgIds,
  clock,
  db,
  events,
  relay,
}: {
  allowedOrgIds: readonly string[];
  clock: Clock;
  db: Database;
  events: EventsService;
  relay: MachineRelayPort;
}) => {
  const nowIso = () => clock.now().toISOString();

  /** A user mints a code for a machine they are about to enrol. It is shown once. */
  const createEnrollToken = async (
    principal: Principal,
    input: EnrollTokenInput
  ): Promise<{ code: string; expiresAt: string }> => {
    const user = requireUser(principal, ENROLL_ACTION);
    const { machineName } = enrollTokenInputSchema.parse(input);
    authorize(user, ENROLL_ACTION, {
      kind: MACHINE_KIND,
      workspaceId: user.workspaceId,
    });
    const now = clock.now();
    const { hash, token } = await hashedToken(ENROLL_TOKEN_PREFIX);
    const expiresAt = new Date(now.getTime() + ENROLL_TTL_MS).toISOString();
    await db.insert(machineEnrollTokens).values({
      createdAt: now.toISOString(),
      createdBy: user.userId,
      expiresAt,
      id: ulid(now.getTime()),
      machineName,
      tokenHash: hash,
      workspaceId: user.workspaceId,
    });
    return { code: token, expiresAt };
  };

  /**
   * Trades an enrol code for a machine and its credential, both shown once.
   * The code is the credential, so there is no principal. Null for a code that
   * is unknown, expired or already used. The spend is one conditional write, so
   * two requests racing on one code see one winner. A crash between the spend
   * and the insert burns the code, and the user mints another.
   */
  const enroll = async (
    input: EnrollInput
  ): Promise<{ credential: string; machineId: string } | null> => {
    const { code, singleUser } = enrollInputSchema.parse(input);
    const now = nowIso();
    const [spent] = await db
      .update(machineEnrollTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(machineEnrollTokens.tokenHash, await hashToken(code)),
          isNull(machineEnrollTokens.usedAt),
          gt(machineEnrollTokens.expiresAt, now)
        )
      )
      .returning({
        createdBy: machineEnrollTokens.createdBy,
        machineName: machineEnrollTokens.machineName,
        workspaceId: machineEnrollTokens.workspaceId,
      });
    if (!spent) {
      return null;
    }
    const { hash, token } = await hashedToken(MACHINE_CREDENTIAL_PREFIX);
    const machineId = ulid(clock.now().getTime());
    await db.insert(machines).values({
      capabilities: "{}",
      createdAt: now,
      credentialHash: hash,
      enrolledBy: spent.createdBy,
      id: machineId,
      lastSeenAt: null,
      name: spent.machineName,
      singleUser,
      status: "offline",
      workspaceId: spent.workspaceId,
    });
    return { credential: token, machineId };
  };

  /**
   * The machine principal for `Authorization: Bearer hm_mach_...`, or null. A
   * revoked machine, an unknown credential and a workspace outside
   * `allowedOrgIds` are all null.
   */
  const authenticate = async (
    authorization: string | null
  ): Promise<MachinePrincipal | null> => {
    const token = bearerToken(authorization);
    if (!token?.startsWith(MACHINE_CREDENTIAL_PREFIX)) {
      return null;
    }
    const principal = await findMachineByCredential(db, token);
    if (!principal) {
      return null;
    }
    const [workspace] = await db
      .select({ clerkOrgId: workspaces.clerkOrgId })
      .from(workspaces)
      .where(eq(workspaces.id, principal.workspaceId))
      .limit(1);
    return workspace && allowedOrgIds.includes(workspace.clerkOrgId)
      ? principal
      : null;
  };

  const list = async (principal: Principal): Promise<MachineRecord[]> => {
    if (principal.kind === "system") {
      throw new ForbiddenError(READ_ACTION);
    }
    authorize(principal, READ_ACTION, {
      kind: MACHINE_KIND,
      workspaceId: principal.workspaceId,
    });
    const rows = await db
      .select()
      .from(machines)
      .where(eq(machines.workspaceId, principal.workspaceId))
      .orderBy(asc(machines.name), asc(machines.id));
    return rows.map(toRecord);
  };

  /**
   * Ends a machine's credential. HTTP calls with it stop at once, and the relay
   * closes its open sockets with 4401. Safe to repeat, so a failed relay call
   * can be retried.
   */
  const revoke = async (
    principal: Principal,
    machineId: string
  ): Promise<void> => {
    const user = requireUser(principal, REVOKE_ACTION);
    authorize(user, REVOKE_ACTION, {
      id: machineId,
      kind: MACHINE_KIND,
      workspaceId: user.workspaceId,
    });
    const [current] = await db
      .select({ name: machines.name, status: machines.status })
      .from(machines)
      .where(
        and(
          eq(machines.id, machineId),
          eq(machines.workspaceId, user.workspaceId)
        )
      )
      .limit(1);
    if (!current) {
      throw new ServiceError("not_found", "Machine not found");
    }
    const wasOnline = current.status === "online";
    const [revoked] = await db
      .update(machines)
      .set({ status: "revoked" })
      .where(
        and(
          eq(machines.id, machineId),
          eq(machines.workspaceId, user.workspaceId),
          ne(machines.status, "revoked")
        )
      )
      .returning({ id: machines.id });
    if (revoked && wasOnline) {
      await events.append({
        actor: { id: user.userId, kind: "user" },
        payload: { machineId, name: current.name, reason: "revoked" },
        type: "machine.offline",
        workspaceId: user.workspaceId,
      });
    }
    await relay.revoke(machineId);
  };

  /**
   * The relay heard from its machine (`hello` or a ping). Sets `online` and
   * `last_seen_at`, and `capabilities` when the daemon sent them, and appends
   * `machine.online` when the status changed. "revoked" means the machine is
   * revoked or gone, and the relay must close the socket with 4401.
   */
  const markOnline = async (
    principal: Principal,
    seen: { capabilities?: Record<string, unknown> } = {}
  ): Promise<"ok" | "revoked"> => {
    const machine = requireMachine(principal, PRESENCE_ACTION);
    authorize(machine, PRESENCE_ACTION, {
      id: machine.machineId,
      kind: MACHINE_KIND,
      workspaceId: machine.workspaceId,
    });
    const scope = and(
      eq(machines.id, machine.machineId),
      eq(machines.workspaceId, machine.workspaceId)
    );
    const [flipped] = await db
      .update(machines)
      .set({ status: "online" })
      .where(and(scope, eq(machines.status, "offline")))
      .returning({ name: machines.name });
    const [touched] = await db
      .update(machines)
      .set({
        lastSeenAt: nowIso(),
        ...(seen.capabilities
          ? { capabilities: JSON.stringify(seen.capabilities) }
          : {}),
      })
      .where(and(scope, ne(machines.status, "revoked")))
      .returning({ id: machines.id });
    if (!touched) {
      return "revoked";
    }
    if (flipped) {
      await events.append({
        actor: { id: machine.machineId, kind: "system" },
        payload: { machineId: machine.machineId, name: flipped.name },
        type: "machine.online",
        workspaceId: machine.workspaceId,
      });
    }
    return "ok";
  };

  /**
   * The socket closed or the machine went silent. Only an online machine
   * changes: a revoked one stays revoked, and an offline one needs no write.
   */
  const markOffline = async (
    principal: Principal,
    reason: "disconnected" | "silent"
  ): Promise<void> => {
    const machine = requireMachine(principal, PRESENCE_ACTION);
    authorize(machine, PRESENCE_ACTION, {
      id: machine.machineId,
      kind: MACHINE_KIND,
      workspaceId: machine.workspaceId,
    });
    const [flipped] = await db
      .update(machines)
      .set({ status: "offline" })
      .where(
        and(
          eq(machines.id, machine.machineId),
          eq(machines.workspaceId, machine.workspaceId),
          eq(machines.status, "online")
        )
      )
      .returning({ name: machines.name });
    if (flipped) {
      await events.append({
        actor: { id: machine.machineId, kind: "system" },
        payload: {
          machineId: machine.machineId,
          name: flipped.name,
          reason,
        },
        type: "machine.offline",
        workspaceId: machine.workspaceId,
      });
    }
  };

  /**
   * The runs to offer a machine that just said hello: every `queued` or
   * `offered` run of an agent assigned to it, oldest first. A run with files
   * still downloading is left out, because it cannot be claimed yet and the
   * sweep offers it once the files are in.
   */
  const pendingOffers = async (
    principal: Principal
  ): Promise<{ agentId: string; runId: string }[]> => {
    const machine = requireMachine(principal, PRESENCE_ACTION);
    authorize(machine, PRESENCE_ACTION, {
      id: machine.machineId,
      kind: MACHINE_KIND,
      workspaceId: machine.workspaceId,
    });
    return await db
      .select({ agentId: runs.agentId, runId: runs.id })
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(
        and(
          eq(runs.workspaceId, machine.workspaceId),
          eq(agents.machineId, machine.machineId),
          inArray(runs.status, ["queued", "offered"]),
          isNull(runs.pendingFiles)
        )
      )
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .limit(OFFER_BATCH);
  };

  return {
    authenticate,
    createEnrollToken,
    enroll,
    list,
    markOffline,
    markOnline,
    pendingOffers,
    revoke,
  };
};

export type MachinesService = ReturnType<typeof createMachinesService>;
