/**
 * Machines: enrol tokens, machine credentials, presence, attach and revoke. A
 * machine holds one or two roles. A user mints a single-use `hm_enr_` code for
 * a role, the client trades it for a long-lived `hm_mach_` credential (stored
 * only as a hash), and the machine's relay keeps the role's status current.
 * The `agent_host` (daemon) credential lives in `machines.credential_hash`, the
 * `computer` credential in `machine_credentials`, and `authenticate` opens only
 * the role it is asked for. The relay acts as the machine it hosts: it passes
 * that machine's principal to the presence methods.
 */
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import {
  machineCredentials,
  machineEnrollTokens,
  machines,
} from "@repo/db/schema/machines";
import { runs } from "@repo/db/schema/runs";
import { workspaces } from "@repo/db/schema/workspaces";
import {
  type ComputerStatus,
  MACHINE_ROLES,
  type MachineRole,
  type MachineStatus,
} from "@repo/db/shared";
import type { HelloMessage } from "@repo/protocol/computer";
import { machineEnrollRequestSchema } from "@repo/protocol/machine";
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { authorize, ForbiddenError } from "./authz.ts";
import { hashedToken, hashToken, toBase64Url } from "./crypto.ts";
import { isUniqueViolation, ServiceError } from "./errors.ts";
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

/**
 * What a computer-only machine holds in `machines.credential_hash`. SHA-256
 * hashes are lowercase hex, so no bearer token hashes to a value that starts
 * with this, and the machine has no usable daemon credential. It also marks the
 * machine as having no `agent_host` role.
 */
const COMPUTER_ONLY_HASH_PREFIX = "computer-only:";
const RANDOM_BYTES = 32;

const MACHINE_KIND = "machine";
const ENROLL_ACTION = "machines.enroll";
const READ_ACTION = "machines.read";
const REVOKE_ACTION = "machines.revoke";
const PRESENCE_ACTION = "machines.presence";
const ATTACH_ACTION = "machines.attach";

/** The runtimes whose agent can drive a computer, since a machine agent runs on one already. */
const ATTACHABLE_RUNTIMES: readonly string[] = ["cloud", "managed"];

type UserPrincipal = Extract<Principal, { kind: "user" }>;
export type MachinePrincipal = Extract<Principal, { kind: "machine" }>;

/**
 * `machineId` adds the `computer` role to a machine that exists. Without it the
 * code makes a new machine, which needs a name.
 */
export const enrollTokenInputSchema = z
  .strictObject({
    machineId: z.string().min(1).max(200).optional(),
    machineName: z.string().trim().min(1).max(80).optional(),
    role: z.enum(MACHINE_ROLES).default("agent_host"),
  })
  .refine((input) => input.machineId !== undefined || input.machineName, {
    message: "A new machine needs a name",
    path: ["machineName"],
  });
export type EnrollTokenInput = z.input<typeof enrollTokenInputSchema>;

/** A daemon body (`code`, `singleUser`) or a computer client body (`role: "computer"`). */
export const enrollInputSchema = machineEnrollRequestSchema;
export type EnrollInput = z.input<typeof enrollInputSchema>;

/** What `authenticate` can open. The two roles never share a credential. */
export type AuthenticateRole = MachineRole;

/** A machine row as the services hand it out. Never carries the credential hash. */
export interface MachineRecord {
  capabilities: Record<string, unknown>;
  /** What the computer client sent in its hello. Null before it first connects. */
  computerCapabilities: Record<string, unknown> | null;
  computerLastSeenAt: string | null;
  /** Presence of the computer role, null when the machine has none. */
  computerStatus: ComputerStatus | null;
  createdAt: string;
  enrolledBy: string;
  id: string;
  lastSeenAt: string | null;
  name: string;
  roles: MachineRole[];
  singleUser: boolean;
  /** Presence of the `agent_host` role (the daemon). `revoked` covers both roles. */
  status: MachineStatus;
  workspaceId: string;
}

type MachineRow = typeof machines.$inferSelect;

const capabilitiesSchema = z.record(z.string(), z.json());

const rolesOf = (row: MachineRow): MachineRole[] => [
  ...(row.credentialHash.startsWith(COMPUTER_ONLY_HASH_PREFIX)
    ? []
    : (["agent_host"] as const)),
  ...(row.computerStatus === null ? [] : (["computer"] as const)),
];

const toRecord = (row: MachineRow): MachineRecord => ({
  capabilities: capabilitiesSchema.parse(JSON.parse(row.capabilities)),
  computerCapabilities:
    row.computerCapabilities === null
      ? null
      : capabilitiesSchema.parse(JSON.parse(row.computerCapabilities)),
  computerLastSeenAt: row.computerLastSeenAt,
  computerStatus: row.computerStatus,
  createdAt: row.createdAt,
  enrolledBy: row.enrolledBy,
  id: row.id,
  lastSeenAt: row.lastSeenAt,
  name: row.name,
  roles: rolesOf(row),
  singleUser: row.singleUser,
  status: row.status,
  workspaceId: row.workspaceId,
});

const computerTaken = () =>
  new ServiceError("conflict", "That computer already serves another agent");

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
  atomic,
  clock,
  db,
  events,
  relay,
}: {
  allowedOrgIds: readonly string[];
  atomic: Atomic;
  clock: Clock;
  db: Database;
  events: EventsService;
  relay: MachineRelayPort;
}) => {
  const nowIso = () => clock.now().toISOString();

  /**
   * The name a code gives its machine. For a code that adds the computer role
   * to a machine that exists, that is the machine's own name, and the machine
   * must be live and have no computer role yet.
   */
  const existingMachineName = async (
    workspaceId: string,
    machineId: string
  ): Promise<string> => {
    const [machine] = await db
      .select({
        computerStatus: machines.computerStatus,
        name: machines.name,
        status: machines.status,
      })
      .from(machines)
      .where(
        and(eq(machines.id, machineId), eq(machines.workspaceId, workspaceId))
      )
      .limit(1);
    if (!machine || machine.status === "revoked") {
      throw new ServiceError("not_found", "Machine not found");
    }
    if (machine.computerStatus !== null) {
      throw new ServiceError("conflict", "That machine already has a computer");
    }
    return machine.name;
  };

  /**
   * A user mints a code for a machine they are about to enrol. It is shown
   * once. `role: "computer"` with a `machineId` adds the computer role to that
   * machine, and the daemon role cannot be added to a machine that exists.
   */
  const createEnrollToken = async (
    principal: Principal,
    input: EnrollTokenInput
  ): Promise<{ code: string; expiresAt: string }> => {
    const user = requireUser(principal, ENROLL_ACTION);
    const { machineId, machineName, role } =
      enrollTokenInputSchema.parse(input);
    authorize(user, ENROLL_ACTION, {
      kind: MACHINE_KIND,
      workspaceId: user.workspaceId,
    });
    if (machineId !== undefined && role !== "computer") {
      throw new ServiceError(
        "invalid",
        "Only the computer role can be added to a machine that exists"
      );
    }
    const name =
      machineId === undefined
        ? machineName
        : await existingMachineName(user.workspaceId, machineId);
    if (name === undefined) {
      throw new ServiceError("invalid", "A new machine needs a name");
    }
    const now = clock.now();
    const { hash, token } = await hashedToken(ENROLL_TOKEN_PREFIX);
    const expiresAt = new Date(now.getTime() + ENROLL_TTL_MS).toISOString();
    await db.insert(machineEnrollTokens).values({
      createdAt: now.toISOString(),
      createdBy: user.userId,
      expiresAt,
      id: ulid(now.getTime()),
      machineId: machineId ?? null,
      machineName: name,
      role,
      tokenHash: hash,
      workspaceId: user.workspaceId,
    });
    return { code: token, expiresAt };
  };

  /**
   * The computer role for a spent code: a new computer-only machine, or a
   * credential added to the machine the code names. Null when that machine is
   * gone, revoked or already has a computer.
   */
  const enrollComputer = async (spent: {
    createdBy: string;
    machineId: string | null;
    machineName: string;
    workspaceId: string;
  }): Promise<{ credential: string; machineId: string } | null> => {
    const now = nowIso();
    const { hash, token } = await hashedToken(MACHINE_CREDENTIAL_PREFIX);
    if (spent.machineId === null) {
      const machineId = ulid(clock.now().getTime());
      await atomic([
        db.insert(machines).values({
          capabilities: "{}",
          computerStatus: "offline",
          createdAt: now,
          credentialHash: `${COMPUTER_ONLY_HASH_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(RANDOM_BYTES)))}`,
          enrolledBy: spent.createdBy,
          id: machineId,
          lastSeenAt: null,
          name: spent.machineName,
          singleUser: false,
          status: "offline",
          workspaceId: spent.workspaceId,
        }),
        db.insert(machineCredentials).values({
          createdAt: now,
          credentialHash: hash,
          machineId,
          role: "computer",
          workspaceId: spent.workspaceId,
        }),
      ]);
      return { credential: token, machineId };
    }
    const [machine] = await db
      .select({ id: machines.id })
      .from(machines)
      .where(
        and(
          eq(machines.id, spent.machineId),
          eq(machines.workspaceId, spent.workspaceId),
          ne(machines.status, "revoked"),
          isNull(machines.computerStatus)
        )
      )
      .limit(1);
    if (!machine) {
      return null;
    }
    await atomic([
      db.insert(machineCredentials).values({
        createdAt: now,
        credentialHash: hash,
        machineId: machine.id,
        role: "computer",
        workspaceId: spent.workspaceId,
      }),
      db
        .update(machines)
        .set({ computerStatus: "offline" })
        .where(eq(machines.id, machine.id)),
    ]);
    return { credential: token, machineId: machine.id };
  };

  /**
   * Trades an enrol code for a machine and its credential, both shown once.
   * The code is the credential, so there is no principal. Null for a code that
   * is unknown, expired, already used or minted for the other role. The spend
   * is one conditional write, so two requests racing on one code see one
   * winner. A crash between the spend and the insert burns the code, and the
   * user mints another.
   */
  const enroll = async (
    input: EnrollInput
  ): Promise<{ credential: string; machineId: string } | null> => {
    const body = enrollInputSchema.parse(input);
    const role: MachineRole = "role" in body ? body.role : "agent_host";
    const now = nowIso();
    const [spent] = await db
      .update(machineEnrollTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(machineEnrollTokens.tokenHash, await hashToken(body.code)),
          eq(machineEnrollTokens.role, role),
          isNull(machineEnrollTokens.usedAt),
          gt(machineEnrollTokens.expiresAt, now)
        )
      )
      .returning({
        createdBy: machineEnrollTokens.createdBy,
        machineId: machineEnrollTokens.machineId,
        machineName: machineEnrollTokens.machineName,
        workspaceId: machineEnrollTokens.workspaceId,
      });
    if (!spent) {
      return null;
    }
    if ("role" in body) {
      return await enrollComputer(spent);
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
      singleUser: body.singleUser,
      status: "offline",
      workspaceId: spent.workspaceId,
    });
    return { credential: token, machineId };
  };

  /** The live machine a computer credential belongs to, or null. */
  const findComputerByCredential = async (
    token: string
  ): Promise<MachinePrincipal | null> => {
    const [row] = await db
      .select({
        machineId: machineCredentials.machineId,
        workspaceId: machineCredentials.workspaceId,
      })
      .from(machineCredentials)
      .innerJoin(machines, eq(machines.id, machineCredentials.machineId))
      .where(
        and(
          eq(machineCredentials.credentialHash, await hashToken(token)),
          eq(machineCredentials.role, "computer"),
          ne(machines.status, "revoked")
        )
      )
      .limit(1);
    return row ? { kind: "machine", ...row } : null;
  };

  /**
   * The machine principal for `Authorization: Bearer hm_mach_...` as one role,
   * or null. A daemon credential never opens the computer role and the reverse.
   * A revoked machine, an unknown credential and a workspace outside
   * `allowedOrgIds` are all null.
   */
  const authenticate = async (
    authorization: string | null,
    role: AuthenticateRole = "agent_host"
  ): Promise<MachinePrincipal | null> => {
    const token = bearerToken(authorization);
    if (!token?.startsWith(MACHINE_CREDENTIAL_PREFIX)) {
      return null;
    }
    const principal =
      role === "computer"
        ? await findComputerByCredential(token)
        : await findMachineByCredential(db, token);
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
   * Ends a machine's credentials, both roles at once, because `revoked` is read
   * on every lookup. HTTP calls with them stop at once, and the relay closes
   * every open socket with 4401. Safe to repeat, so a failed relay call can be
   * retried.
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
      .select({
        computerStatus: machines.computerStatus,
        name: machines.name,
        status: machines.status,
      })
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
    const computerWasOnline = current.computerStatus === "online";
    const [revoked] = await db
      .update(machines)
      .set({
        status: "revoked",
        ...(computerWasOnline ? { computerStatus: "offline" } : {}),
      })
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
    if (revoked && computerWasOnline) {
      await events.append({
        actor: { id: user.userId, kind: "user" },
        payload: { machineId },
        type: "computer.offline",
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
   * The relay heard the computer role's v1 hello. Sets `computer_status` to
   * `online`, stores `computer_last_seen_at` and the capabilities the client
   * sent, and appends `computer.online` when the status changed. "revoked" means
   * the machine is revoked, gone or has no computer role, and the relay must
   * close the socket with 4401.
   */
  const markComputerOnline = async (
    principal: Principal,
    hello: HelloMessage
  ): Promise<"ok" | "revoked"> => {
    const machine = requireMachine(principal, PRESENCE_ACTION);
    authorize(machine, PRESENCE_ACTION, {
      id: machine.machineId,
      kind: MACHINE_KIND,
      workspaceId: machine.workspaceId,
    });
    const scope = and(
      eq(machines.id, machine.machineId),
      eq(machines.workspaceId, machine.workspaceId),
      ne(machines.status, "revoked")
    );
    const [flipped] = await db
      .update(machines)
      .set({ computerStatus: "online" })
      .where(and(scope, eq(machines.computerStatus, "offline")))
      .returning({ id: machines.id });
    const [touched] = await db
      .update(machines)
      .set({
        computerCapabilities: JSON.stringify({
          arch: hello.arch,
          clientVersion: hello.version,
          desktop: hello.capabilities.desktop,
          os: hello.os,
          workdir: hello.workdir,
        }),
        computerLastSeenAt: nowIso(),
      })
      .where(and(scope, isNotNull(machines.computerStatus)))
      .returning({ id: machines.id });
    if (!touched) {
      return "revoked";
    }
    if (flipped) {
      await events.append({
        actor: { id: machine.machineId, kind: "system" },
        payload: { machineId: machine.machineId },
        type: "computer.online",
        workspaceId: machine.workspaceId,
      });
    }
    return "ok";
  };

  /**
   * The computer socket closed or went silent. Only an online computer
   * changes: a revoked machine was already set offline by `revoke`.
   */
  const markComputerOffline = async (principal: Principal): Promise<void> => {
    const machine = requireMachine(principal, PRESENCE_ACTION);
    authorize(machine, PRESENCE_ACTION, {
      id: machine.machineId,
      kind: MACHINE_KIND,
      workspaceId: machine.workspaceId,
    });
    const [flipped] = await db
      .update(machines)
      .set({ computerStatus: "offline" })
      .where(
        and(
          eq(machines.id, machine.machineId),
          eq(machines.workspaceId, machine.workspaceId),
          eq(machines.computerStatus, "online")
        )
      )
      .returning({ id: machines.id });
    if (flipped) {
      await events.append({
        actor: { id: machine.machineId, kind: "system" },
        payload: { machineId: machine.machineId },
        type: "computer.offline",
        workspaceId: machine.workspaceId,
      });
    }
  };

  /**
   * Gives a cloud or managed agent a computer to drive, or takes it away with
   * `null`. The computer is a machine of this workspace that has the computer
   * role, and it serves one agent at a time.
   */
  const attachComputer = async (
    principal: Principal,
    agentId: string,
    machineId: string | null
  ): Promise<void> => {
    const user = requireUser(principal, ATTACH_ACTION);
    authorize(user, ATTACH_ACTION, {
      id: agentId,
      kind: "agent",
      workspaceId: user.workspaceId,
    });
    const agentScope = and(
      eq(agents.id, agentId),
      eq(agents.workspaceId, user.workspaceId)
    );
    const [agent] = await db
      .select({
        computerMachineId: agents.computerMachineId,
        runtime: agents.runtime,
      })
      .from(agents)
      .where(agentScope)
      .limit(1);
    if (!agent) {
      throw new ServiceError("not_found", "Agent not found");
    }
    if (!ATTACHABLE_RUNTIMES.includes(agent.runtime)) {
      throw new ServiceError(
        "invalid",
        `A "${agent.runtime}" agent cannot have a computer. Only cloud and managed agents can.`
      );
    }
    if (machineId !== null) {
      const [machine] = await db
        .select({ id: machines.id })
        .from(machines)
        .where(
          and(
            eq(machines.id, machineId),
            eq(machines.workspaceId, user.workspaceId),
            ne(machines.status, "revoked"),
            isNotNull(machines.computerStatus)
          )
        )
        .limit(1);
      if (!machine) {
        throw new ServiceError("invalid", "That machine has no computer role");
      }
    }
    if (agent.computerMachineId === machineId) {
      return;
    }
    try {
      await db
        .update(agents)
        .set({ computerMachineId: machineId })
        .where(agentScope);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw computerTaken();
      }
      throw error;
    }
    await events.append({
      actor: { id: user.userId, kind: "user" },
      agentId,
      payload: { changed: ["computerMachineId"] },
      type: "agent.updated",
      workspaceId: user.workspaceId,
    });
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
    attachComputer,
    authenticate,
    createEnrollToken,
    enroll,
    list,
    markComputerOffline,
    markComputerOnline,
    markOffline,
    markOnline,
    pendingOffers,
    revoke,
  };
};

export type MachinesService = ReturnType<typeof createMachinesService>;
