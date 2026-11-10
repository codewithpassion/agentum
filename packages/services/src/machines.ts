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
  MACHINE_ENROLL_ROLES,
  type MachineEnrollRole,
  type MachineRole,
  type MachineStatus,
} from "@repo/db/shared";
import type { HelloMessage } from "@repo/protocol/computer";
import {
  type EnrollResponse,
  machineEnrollRequestSchema,
  type RolesEnrollRequest,
  type RolesEnrollResponse,
} from "@repo/protocol/machine";
import type { Product } from "@repo/protocol/releases";
import { ENROLL_CODE, MACHINE_CREDENTIAL } from "@repo/protocol/token-prefixes";
import {
  and,
  asc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { authorize, ForbiddenError } from "./authz.ts";
import { hashedToken, hashToken, toBase64Url } from "./crypto.ts";
import { isUniqueViolation, ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import type {
  ComputerOutcome,
  ComputerStatus as ComputerRelayStatus,
  MachineRelayPort,
} from "./machines/types.ts";
import type { Clock } from "./runs/types.ts";
import {
  bearerToken,
  findMachineByCredential,
  type Principal,
} from "./workspaces.ts";

/** The prefix new enroll codes get. Check with `ENROLL_CODE` from token-prefixes. */
export const ENROLL_TOKEN_PREFIX = ENROLL_CODE.issue;
/** The prefix new credentials get. Check with `MACHINE_CREDENTIAL`. */
export const MACHINE_CREDENTIAL_PREFIX = MACHINE_CREDENTIAL.issue;
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
    role: z.enum(MACHINE_ENROLL_ROLES).default("agent_host"),
  })
  .refine((input) => input.machineId !== undefined || input.machineName, {
    message: "A new machine needs a name",
    path: ["machineName"],
  });
export type EnrollTokenInput = z.input<typeof enrollTokenInputSchema>;

/** Legacy daemon/computer bodies or the new roles body. */
export const enrollInputSchema = machineEnrollRequestSchema;
export type EnrollInput = z.input<typeof enrollInputSchema>;

/** The role `authenticate` checks for in the credential tables. */
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
  /** The version the daemon reported in its last hello. Null before it first connects. */
  daemonVersion: string | null;
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

/** The enrol code's own columns, read before the spend. */
interface SpendableCode {
  createdBy: string;
  machineId: string | null;
  machineName: string;
  workspaceId: string;
}

type Statement = Parameters<Atomic>[0][number];

/**
 * See `spendOf`. `commit` runs the statements and the spend, then asks `landed`
 * whether the guarded insert kept its row. It is false when another request
 * spent the code first.
 */
interface Spend {
  commit: (
    statements: Statement[],
    landed: () => Promise<boolean>
  ) => Promise<boolean>;
  insertCredential: (row: typeof machineCredentials.$inferInsert) => Statement;
  insertMachine: (row: typeof machines.$inferInsert) => Statement;
  stillSpendable: SQL;
}

const capabilitiesSchema = z.record(z.string(), z.json());

/** Whether a machine's stored credential hash gives it the `agent_host` role. */
export const hasAgentHostRole = (credentialHash: string): boolean =>
  !credentialHash.startsWith(COMPUTER_ONLY_HASH_PREFIX);

const rolesOf = (row: MachineRow): MachineRole[] => [
  ...(hasAgentHostRole(row.credentialHash) ? (["agent_host"] as const) : []),
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
  daemonVersion: row.daemonVersion,
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
  atomic,
  clock,
  db,
  events,
  latestDaemonVersion,
  relay,
}: {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  events: EventsService;
  /** The version of the newest published daemon, or null when there is none. Without it the answer is null. */
  latestDaemonVersion?: (product?: Product) => Promise<string | null>;
  relay: MachineRelayPort;
}) => {
  const nowIso = () => clock.now().toISOString();

  /**
   * Writes guarded by an enrol code, so the code is spent in the same `atomic`
   * call as the rows it pays for. Each insert keeps its row only while the
   * code is still spendable, and the spend itself comes last, so a failed write
   * leaves the code unspent and two requests on one code see one winner.
   */
  const machineLanded = (machineId: string) => async () =>
    (
      await db
        .select({ id: machines.id })
        .from(machines)
        .where(eq(machines.id, machineId))
        .limit(1)
    ).length > 0;
  const credentialLanded = (credentialHash: string) => async () =>
    (
      await db
        .select({ id: machineCredentials.machineId })
        .from(machineCredentials)
        .where(eq(machineCredentials.credentialHash, credentialHash))
        .limit(1)
    ).length > 0;

  const spendOf = (spendable: SQL | undefined, now: string): Spend => {
    const stillSpendable = sql`exists (select 1 from ${machineEnrollTokens} where ${spendable})`;
    const guardedInsert = <
      T extends typeof machines | typeof machineCredentials,
    >(
      table: T,
      row: Record<string, unknown>
    ) => {
      const values = Object.keys(getTableColumns(table)).map((key) => {
        const value = row[key] ?? null;
        return sql`${typeof value === "boolean" ? Number(value) : value}`;
      });
      return db
        .insert(table)
        .select(
          sql`select ${sql.join(values, sql`, `)} where ${stillSpendable}`
        );
    };
    return {
      commit: async (statements, landed) => {
        await atomic([
          ...statements,
          db.update(machineEnrollTokens).set({ usedAt: now }).where(spendable),
        ]);
        return await landed();
      },
      insertCredential: (row) => guardedInsert(machineCredentials, row),
      insertMachine: (row) => guardedInsert(machines, row),
      stillSpendable,
    };
  };

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
   * The computer role for a code: a new computer-only machine, or a credential
   * added to the machine the code names. Null when that machine is gone,
   * revoked or already has a computer, or when the code was spent meanwhile.
   */
  const enrollComputer = async (
    spent: SpendableCode,
    spend: Spend
  ): Promise<{ credential: string; machineId: string } | null> => {
    const now = nowIso();
    const { hash, token } = await hashedToken(MACHINE_CREDENTIAL_PREFIX);
    if (spent.machineId === null) {
      const machineId = ulid(clock.now().getTime());
      const won = await spend.commit(
        [
          spend.insertMachine({
            capabilities: "{}",
            computerStatus: "offline",
            createdAt: now,
            credentialHash: `${COMPUTER_ONLY_HASH_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(RANDOM_BYTES)))}`,
            enrolledBy: spent.createdBy,
            id: machineId,
            name: spent.machineName,
            singleUser: false,
            status: "offline",
            workspaceId: spent.workspaceId,
          }),
          spend.insertCredential({
            createdAt: now,
            credentialHash: hash,
            machineId,
            role: "computer",
            workspaceId: spent.workspaceId,
          }),
        ],
        machineLanded(machineId)
      );
      return won ? { credential: token, machineId } : null;
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
    const won = await spend.commit(
      [
        spend.insertCredential({
          createdAt: now,
          credentialHash: hash,
          machineId: machine.id,
          role: "computer",
          workspaceId: spent.workspaceId,
        }),
        db
          .update(machines)
          .set({ computerStatus: "offline" })
          .where(and(eq(machines.id, machine.id), spend.stillSpendable)),
      ],
      credentialLanded(hash)
    );
    return won ? { credential: token, machineId: machine.id } : null;
  };

  const resolveEnrollRole = async (
    body: RolesEnrollRequest
  ): Promise<MachineEnrollRole | null> => {
    const now = nowIso();
    const tokenHash = await hashToken(body.code);
    const [code] = await db
      .select()
      .from(machineEnrollTokens)
      .where(
        and(
          eq(machineEnrollTokens.tokenHash, tokenHash),
          isNull(machineEnrollTokens.usedAt),
          gt(machineEnrollTokens.expiresAt, now)
        )
      )
      .limit(1);
    if (!code) {
      return null;
    }
    if (code.machineId !== null) {
      throw new ServiceError(
        "invalid",
        "This code adds a role to an existing machine; enrol it with the older computer client"
      );
    }
    const { role } = code;
    const roles: MachineRole[] =
      role === "both" ? ["agent_host", "computer"] : [role];
    if (
      body.roles &&
      (body.roles.length !== roles.length ||
        body.roles.some((item) => !roles.includes(item)))
    ) {
      throw new ServiceError(
        "invalid",
        "Requested roles do not match the enrolment code's roles"
      );
    }
    return role;
  };

  const enrollRoles = async (
    spent: SpendableCode,
    spend: Spend,
    body: RolesEnrollRequest,
    role: MachineEnrollRole,
    now: string
  ): Promise<RolesEnrollResponse | null> => {
    const roles: MachineRole[] =
      role === "both" ? ["agent_host", "computer"] : [role];
    const { hash, token } = await hashedToken(MACHINE_CREDENTIAL_PREFIX);
    const machineId = ulid(clock.now().getTime());
    const won = await spend.commit(
      [
        spend.insertMachine({
          capabilities: "{}",
          computerStatus: roles.includes("computer") ? "offline" : null,
          createdAt: now,
          credentialHash: roles.includes("agent_host")
            ? hash
            : `${COMPUTER_ONLY_HASH_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(RANDOM_BYTES)))}`,
          enrolledBy: spent.createdBy,
          id: machineId,
          name: spent.machineName,
          singleUser: roles.includes("agent_host") && body.singleUser,
          status: "offline",
          workspaceId: spent.workspaceId,
        }),
        ...(roles.includes("computer")
          ? [
              spend.insertCredential({
                createdAt: now,
                credentialHash: hash,
                machineId,
                role: "computer",
                workspaceId: spent.workspaceId,
              }),
            ]
          : []),
      ],
      machineLanded(machineId)
    );
    return won
      ? { credential: token, machineId, machineName: spent.machineName, roles }
      : null;
  };

  /**
   * Trades an enrol code for a machine and its credential, both shown once.
   * The code is the credential, so there is no principal. Null for a code that
   * is unknown, expired, already used or minted for the other role. The spend
   * is in the same `atomic` call as the inserts, so two requests racing on one
   * code see one winner and a failed write leaves the code usable.
   */
  const enroll = async (
    input: EnrollInput
  ): Promise<EnrollResponse | RolesEnrollResponse | null> => {
    const body = enrollInputSchema.parse(input);
    const now = nowIso();
    const tokenHash = await hashToken(body.code);
    const newBody = "hostname" in body && "singleUser" in body;
    let role: MachineEnrollRole = "role" in body ? body.role : "agent_host";
    if (newBody) {
      const resolved = await resolveEnrollRole(body);
      if (resolved === null) {
        return null;
      }
      role = resolved;
    }
    const spendable = and(
      eq(machineEnrollTokens.tokenHash, tokenHash),
      eq(machineEnrollTokens.role, role),
      ...(newBody ? [isNull(machineEnrollTokens.machineId)] : []),
      isNull(machineEnrollTokens.usedAt),
      gt(machineEnrollTokens.expiresAt, now)
    );
    const [spent] = await db
      .select({
        createdBy: machineEnrollTokens.createdBy,
        machineId: machineEnrollTokens.machineId,
        machineName: machineEnrollTokens.machineName,
        workspaceId: machineEnrollTokens.workspaceId,
      })
      .from(machineEnrollTokens)
      .where(spendable)
      .limit(1);
    if (!spent) {
      return null;
    }
    const spend = spendOf(spendable, now);
    if ("role" in body) {
      return await enrollComputer(spent, spend);
    }
    if (newBody) {
      return await enrollRoles(spent, spend, body, role, now);
    }
    const { hash, token } = await hashedToken(MACHINE_CREDENTIAL_PREFIX);
    const machineId = ulid(clock.now().getTime());
    const won = await spend.commit(
      [
        spend.insertMachine({
          capabilities: "{}",
          computerStatus: null,
          createdAt: now,
          credentialHash: hash,
          enrolledBy: spent.createdBy,
          id: machineId,
          name: spent.machineName,
          singleUser: body.singleUser,
          status: "offline",
          workspaceId: spent.workspaceId,
        }),
      ],
      machineLanded(machineId)
    );
    return won ? { credential: token, machineId } : null;
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
   * or null. A new both-role credential opens either; legacy credentials stay scoped.
   * A revoked machine, an unknown credential and a workspace with no row are
   * all null.
   */
  const authenticate = async (
    authorization: string | null,
    role: AuthenticateRole = "agent_host"
  ): Promise<MachinePrincipal | null> => {
    const token = bearerToken(authorization);
    if (!(token && MACHINE_CREDENTIAL.matches(token))) {
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
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, principal.workspaceId))
      .limit(1);
    return workspace ? principal : null;
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

  /** The newest published daemon version, for the machines page to compare against. */
  const newestDaemonVersion = async (
    principal: Principal,
    product: Product = "agentum"
  ): Promise<string | null> => {
    if (principal.kind === "system") {
      throw new ForbiddenError(READ_ACTION);
    }
    authorize(principal, READ_ACTION, {
      kind: MACHINE_KIND,
      workspaceId: principal.workspaceId,
    });
    return (await latestDaemonVersion?.(product)) ?? null;
  };

  /**
   * The relay heard from its machine (`hello` or a ping). Sets `online` and
   * `last_seen_at`, and `capabilities` and `daemon_version` when the daemon sent them, and appends
   * `machine.online` when the status changed. "revoked" means the machine is
   * revoked or gone, and the relay must close the socket with 4401.
   */
  const markOnline = async (
    principal: Principal,
    seen: {
      capabilities?: Record<string, unknown>;
      daemonVersion?: string;
    } = {}
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
        ...(seen.daemonVersion === undefined
          ? {}
          : { daemonVersion: seen.daemonVersion }),
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
    // Detaching is always allowed, so a computer never stays pinned to an agent
    // whose runtime changed after the attach.
    if (machineId !== null && !ATTACHABLE_RUNTIMES.includes(agent.runtime)) {
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
  ): Promise<{ agentId: string; runId: string; subagent?: boolean }[]> => {
    const machine = requireMachine(principal, PRESENCE_ACTION);
    authorize(machine, PRESENCE_ACTION, {
      id: machine.machineId,
      kind: MACHINE_KIND,
      workspaceId: machine.workspaceId,
    });
    const offered = await db
      .select({
        agentId: runs.agentId,
        runId: runs.id,
        subagentLevel: runs.subagentLevel,
      })
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(
        and(
          eq(runs.workspaceId, machine.workspaceId),
          eq(agents.machineId, machine.machineId),
          inArray(runs.status, ["queued", "offered"]),
          isNull(runs.pendingFiles),
          // Ordinary daemon offers cannot carry a scoped guest capability.
          isNull(runs.scopeArtifactId)
        )
      )
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .limit(OFFER_BATCH);
    return offered.map(({ subagentLevel, ...run }) => ({
      ...run,
      ...(subagentLevel > 0 ? { subagent: true } : {}),
    }));
  };

  /**
   * The computer role of a machine the caller may watch. A machine of another
   * workspace, a revoked one and one without the computer role all answer
   * `not_found`, so the caller cannot tell them apart from a missing machine.
   */
  const requireComputer = async (
    principal: Principal,
    machineId: string
  ): Promise<void> => {
    const user = requireUser(principal, READ_ACTION);
    authorize(user, READ_ACTION, {
      id: machineId,
      kind: MACHINE_KIND,
      workspaceId: user.workspaceId,
    });
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
      throw new ServiceError("not_found", "Machine not found");
    }
  };

  const desktopStatus = async (
    principal: Principal,
    machineId: string
  ): Promise<ComputerRelayStatus> => {
    await requireComputer(principal, machineId);
    return await relay.computerStatus(machineId);
  };

  const clipboardRead = async (
    principal: Principal,
    machineId: string
  ): Promise<ComputerOutcome> => {
    await requireComputer(principal, machineId);
    const user = requireUser(principal, READ_ACTION);
    return await relay.clipboardGet(machineId, {
      kind: "human",
      userId: user.userId,
    });
  };

  const clipboardWrite = async (
    principal: Principal,
    machineId: string,
    text: string
  ): Promise<ComputerOutcome> => {
    await requireComputer(principal, machineId);
    const user = requireUser(principal, READ_ACTION);
    return await relay.clipboardSet(
      machineId,
      { kind: "human", userId: user.userId },
      { selections: ["clipboard", "primary"], text }
    );
  };

  return {
    attachComputer,
    authenticate,
    clipboardRead,
    clipboardWrite,
    createEnrollToken,
    desktopStatus,
    enroll,
    list,
    markComputerOffline,
    markComputerOnline,
    markOffline,
    markOnline,
    newestDaemonVersion,
    pendingOffers,
    requireComputer,
    revoke,
  };
};

export type MachinesService = ReturnType<typeof createMachinesService>;
