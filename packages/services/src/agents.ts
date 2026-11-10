import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { machines } from "@repo/db/schema/machines";
import {
  managedSessions,
  workspaceAnthropicKeys,
} from "@repo/db/schema/managed";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import {
  AGENT_RUNTIMES,
  AGENT_STATUSES,
  type AgentRuntime,
  type AgentStatus,
  LIVE_RUN_STATUSES,
} from "@repo/db/shared";
import { MAX_TURNS_KEY, maxTurnsError } from "@repo/protocol/safeguards";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { authorize, ForbiddenError } from "./authz.ts";
import {
  CLOUD_ENVIRONMENT_KEY,
  cloudEnvironmentError,
} from "./cloud/environment.ts";
import { CLOUD_DEFAULT_MODEL, isAnthropicModel } from "./cloud/models.ts";
import { CLOUD_NETWORK_KEY, networkAccessError } from "./cloud/network.ts";
import { isUniqueViolation, ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import { effectiveOwner, readableWorkspace, requireUser } from "./guards.ts";
import { hasAgentHostRole } from "./machines.ts";
import { NO_KEY_MESSAGE } from "./managed/keys.ts";
import type { MembersService } from "./members.ts";
import type { Principal } from "./workspaces.ts";

const AGENT_CREATE = "agents.create";
const AGENT_READ = "agents.read";
const AGENT_UPDATE = "agents.update";
const AGENT_CHANGE_RUNTIME = "agents.change_runtime";
const AGENT_ARCHIVE = "agents.archive";
const AGENT_KIND = "agent";

const SLUG_MIN = 2;
const SLUG_MAX = 40;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NON_SLUG_RUN = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;

const nameSchema = z.string().trim().min(1).max(80);
const instructionsSchema = z.string().max(50_000);
const soulSchema = z.string().max(10_000);
const modelSchema = z.string().min(1).max(100);
const machineIdSchema = z.string().min(1).max(200);
const runtimeConfigSchema = z.record(z.string(), z.json());
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
const handsToSchema = z.array(z.string());

/** Fails an agent whose `runtimeConfig` names a cloud environment that does not exist, or that sets one on an agent that does not run in the cloud, or whose network setting is not a boolean or is set on an agent that does not run in the cloud, or whose library paths are invalid, or whose turn limit is out of range, or that sets a turn limit on a managed agent, which has no turn count. */
const assertRuntimeConfig = (
  runtime: AgentRuntime,
  runtimeConfig: RuntimeConfig
): void => {
  const issue = cloudEnvironmentError(runtimeConfig);
  if (issue !== undefined) {
    throw new ServiceError("invalid", issue);
  }
  const networkIssue = networkAccessError(runtimeConfig);
  if (networkIssue !== undefined) {
    throw new ServiceError("invalid", networkIssue);
  }
  if (runtime !== "cloud" && CLOUD_ENVIRONMENT_KEY in runtimeConfig) {
    throw new ServiceError(
      "invalid",
      `Only a cloud agent takes an environment, not "${runtime}"`
    );
  }
  if (runtime !== "cloud" && CLOUD_NETWORK_KEY in runtimeConfig) {
    throw new ServiceError(
      "invalid",
      `Only a cloud agent takes network access, not "${runtime}"`
    );
  }
  const turnsIssue = maxTurnsError(runtimeConfig);
  if (turnsIssue !== undefined) {
    throw new ServiceError("invalid", turnsIssue);
  }
  if (runtime === "managed" && MAX_TURNS_KEY in runtimeConfig) {
    throw new ServiceError("invalid", "A managed agent has no turn limit");
  }
};

/** Refuses a model for another provider on a runtime that runs Anthropic models only. */
export const assertModelForRuntime = (
  runtime: AgentRuntime,
  model: string
): void => {
  if (
    (runtime === "managed" || runtime === "machine") &&
    !isAnthropicModel(model)
  ) {
    throw new ServiceError(
      "invalid",
      `The "${runtime}" runtime runs Anthropic models only. Use a cloud agent for "${model.trim()}".`
    );
  }
};

export interface AgentRecord {
  /** Who is asked when the owner does not answer in time, a Clerk user id. Null means no backup. */
  backupUserId: string | null;
  /** The computer this agent drives, or null. Only cloud and managed agents have one. */
  computerMachineId: string | null;
  createdAt: string;
  createdBy: string;
  emailLocal: string | null;
  handsTo: string[];
  id: string;
  instructions: string;
  machineId: string | null;
  model: string;
  name: string;
  /** Who the agent asks, a Clerk user id. Null means `createdBy`. */
  ownerUserId: string | null;
  runtime: AgentRuntime;
  runtimeConfig: RuntimeConfig;
  slug: string;
  soul: string;
  status: AgentStatus;
  subagents: boolean;
  workspaceId: string;
}

type AgentRow = typeof agents.$inferSelect;
type AgentValues = Pick<
  AgentRow,
  | "handsTo"
  | "instructions"
  | "machineId"
  | "model"
  | "name"
  | "runtimeConfig"
  | "slug"
  | "soul"
  | "subagents"
>;
type UserPrincipal = Extract<Principal, { kind: "user" }>;

/** The agent's owner or an org admin, on a browser session. */
const assertOwnerOrAdmin = (
  user: UserPrincipal,
  agent: AgentRecord,
  action = AGENT_UPDATE
): void => {
  if (
    user.via !== "session" ||
    (user.isAdmin !== true && user.userId !== effectiveOwner(agent))
  ) {
    throw new ForbiddenError(action);
  }
};

const statusSchema = z.enum(AGENT_STATUSES);

export const slugSchema = z
  .string()
  .min(SLUG_MIN)
  .max(SLUG_MAX)
  .regex(SLUG_PATTERN);

/** A name as a slug: lowercase, runs of other characters become one "-". */
export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(NON_SLUG_RUN, "-")
    .replace(EDGE_DASHES, "")
    .slice(0, SLUG_MAX)
    .replace(EDGE_DASHES, "");

export const agentCreateSchema = z.strictObject({
  handsTo: handsToSchema.default([]),
  instructions: instructionsSchema.default(""),
  machineId: machineIdSchema.nullish(),
  model: modelSchema,
  name: nameSchema,
  runtime: z.enum(AGENT_RUNTIMES),
  runtimeConfig: runtimeConfigSchema.default({}),
  slug: slugSchema.optional(),
  soul: soulSchema.default(""),
});
export type AgentCreateInput = z.input<typeof agentCreateSchema>;

// The builder chooses the final runtime on activation; draft input cannot override
// the cloud runtime or its default model used by future dry runs.
export const agentDraftSchema = agentCreateSchema.omit({
  machineId: true,
  model: true,
  runtime: true,
});
export type AgentDraftInput = z.input<typeof agentDraftSchema>;

// Activation uses the same defaults as create, including an empty runtimeConfig.
export const agentActivateSchema = agentCreateSchema.pick({
  machineId: true,
  model: true,
  runtime: true,
  runtimeConfig: true,
});
export type AgentActivateInput = z.input<typeof agentActivateSchema>;

// Only the specified character and length rules apply; punctuation is allowed
// at either edge. Reserved operational mailboxes never belong to an agent.
const addressSchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9.-]+$/);
const RESERVED_ADDRESSES = new Set(["postmaster", "abuse", "admin", "noreply"]);
const assertAddress = (local: string): void => {
  if (!addressSchema.safeParse(local).success) {
    throw new ServiceError(
      "invalid",
      "Use 2 to 40 lowercase letters, digits, dots or dashes"
    );
  }
  if (RESERVED_ADDRESSES.has(local)) {
    throw new ServiceError("invalid", "That address is reserved");
  }
};
const addressTaken = (): ServiceError =>
  new ServiceError("conflict", "That address is taken");

/** Suffixes stay within the length limit, including for a 40-character slug. */
const freeName = async (
  base: string,
  taken: (candidate: string) => Promise<boolean>
): Promise<string> => {
  let candidate = base;
  // biome-ignore lint/performance/noAwaitInLoops: Each suffix depends on whether the preceding candidate is taken.
  for (let suffix = 2; await taken(candidate); suffix += 1) {
    const ending = `-${suffix}`;
    candidate = `${base.slice(0, SLUG_MAX - ending.length).replace(EDGE_DASHES, "")}${ending}`;
  }
  return candidate;
};

export const agentUpdateSchema = z
  .strictObject({
    handsTo: handsToSchema.optional(),
    instructions: instructionsSchema.optional(),
    machineId: machineIdSchema.nullish(),
    model: modelSchema.optional(),
    name: nameSchema.optional(),
    runtimeConfig: runtimeConfigSchema.optional(),
    slug: slugSchema.optional(),
    soul: soulSchema.optional(),
    subagents: z.boolean().optional(),
  })
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    "Nothing to update"
  );
export type AgentUpdateInput = z.input<typeof agentUpdateSchema>;

const userIdSchema = z.string().min(1).max(200);

/** Who an agent asks. Null owner means the creator; null backup means none. */
export const agentOwnersSchema = z.strictObject({
  backupUserId: userIdSchema.nullable(),
  ownerUserId: userIdSchema.nullable(),
});
export type AgentOwnersInput = z.input<typeof agentOwnersSchema>;

/** What an agent can be moved to. `model` is for a target that cannot run the current one. */
export const agentRuntimeTargetSchema = z.strictObject({
  machineId: machineIdSchema.optional(),
  model: modelSchema.optional(),
  runtime: z.enum(["cloud", "managed", "machine"]),
});
export type AgentRuntimeTarget = z.input<typeof agentRuntimeTargetSchema>;

/** Config keys only some runtimes take: the environment and network setting are cloud's, the turn limit is not managed's. */
const configKeysDroppedFor = (runtime: AgentRuntime): readonly string[] => [
  ...(runtime === "cloud" ? [] : [CLOUD_ENVIRONMENT_KEY, CLOUD_NETWORK_KEY]),
  ...(runtime === "managed" ? [MAX_TURNS_KEY] : []),
];

/** The agent fields a move sets, for the event. The runtime always counts. */
const changedByMove = (
  current: AgentRecord,
  next: { machineId: string | null; model: string }
): string[] => [
  "runtime",
  ...(next.model === current.model ? [] : ["model"]),
  ...(next.machineId === current.machineId ? [] : ["machineId"]),
];

/** `input` with `patch` set on top of the agent's runtime config, when there is a patch. */
const withConfigPatch = (
  input: AgentUpdateInput,
  current: AgentRecord,
  patch: Record<string, boolean | number | string> | undefined
): AgentUpdateInput =>
  patch
    ? { ...input, runtimeConfig: { ...current.runtimeConfig, ...patch } }
    : input;

/** Why an update wrote no row: the agent is gone, or a guarded config changed. */
const unsavedAgent = (patch: object | undefined): ServiceError =>
  patch
    ? new ServiceError("conflict", "The agent changed, try again")
    : new ServiceError("not_found", "Agent not found");

const toRecord = (row: AgentRow): AgentRecord => ({
  backupUserId: row.backupUserId,
  computerMachineId: row.computerMachineId,
  createdAt: row.createdAt,
  createdBy: row.createdBy,
  emailLocal: row.emailLocal,
  handsTo: handsToSchema.parse(JSON.parse(row.handsTo)),
  id: row.id,
  instructions: row.instructions,
  machineId: row.machineId,
  model: row.model,
  name: row.name,
  ownerUserId: row.ownerUserId,
  runtime: row.runtime,
  runtimeConfig: runtimeConfigSchema.parse(JSON.parse(row.runtimeConfig)),
  slug: row.slug,
  soul: row.soul,
  status: statusSchema.parse(row.status),
  subagents: row.subagents,
  workspaceId: row.workspaceId,
});

/** One agent of one workspace, with no authorization. Any status is returned. */
export const findAgent = async (
  db: Database,
  query: { id: string; workspaceId?: string }
): Promise<AgentRecord | null> => {
  const [row] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.id, query.id),
        query.workspaceId === undefined
          ? undefined
          : eq(agents.workspaceId, query.workspaceId)
      )
    )
    .limit(1);
  return row ? toRecord(row) : null;
};

/** Active handoff names in this workspace, resolved once when a run starts. */
export const handsToNames = async (
  db: Database,
  agent: Pick<AgentRecord, "handsTo" | "id" | "workspaceId">
): Promise<string[]> => {
  if (agent.handsTo.length === 0) {
    return [];
  }
  const rows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(
      and(
        inArray(agents.id, agent.handsTo),
        eq(agents.workspaceId, agent.workspaceId),
        eq(agents.status, "active"),
        ne(agents.id, agent.id)
      )
    );
  const names = new Map(rows.map((row) => [row.id, row.name]));
  // Keep the profile's order; an archived target silently drops out at run start.
  return agent.handsTo.flatMap((id) => {
    const name = names.get(id);
    return name === undefined ? [] : [name];
  });
};

const assertHandsTo = async (
  db: Database,
  agent: Pick<AgentRecord, "handsTo" | "id" | "workspaceId">
): Promise<void> => {
  if ((await handsToNames(db, agent)).length !== agent.handsTo.length) {
    throw new ServiceError(
      "invalid",
      "Hands to must name active agents in this workspace other than this agent"
    );
  }
};

const slugTaken = (slug: string): ServiceError =>
  new ServiceError("conflict", `Slug "${slug}" is taken`);

/** The slug to use: the given one, or one derived from the name. */
const resolveSlug = (given: string | undefined, name: string): string => {
  if (given !== undefined) {
    return given;
  }
  const derived = slugify(name);
  if (!slugSchema.safeParse(derived).success) {
    throw new ServiceError(
      "invalid",
      `Cannot derive a valid slug from "${name}", pass one explicitly`
    );
  }
  return derived;
};

/**
 * The agents of a workspace: create, read, update, archive. Each write
 * appends an `agent.*` event. Only a user principal writes.
 */
/** Fails unless the owner and backup are different people and any id being set is a current member. */
const assertOwners = async (
  user: UserPrincipal,
  members: Pick<MembersService, "list">,
  current: AgentRecord,
  owners: z.output<typeof agentOwnersSchema>
): Promise<void> => {
  const nextOwner = owners.ownerUserId ?? current.createdBy;
  if (owners.backupUserId === nextOwner) {
    throw new ServiceError(
      "invalid",
      "The backup must be someone other than the owner"
    );
  }
  const known = new Set(
    (await members.list(user)).map((member) => member.userId)
  );
  // An id that is not changing may belong to someone who has since left.
  const changing = [
    owners.ownerUserId === current.ownerUserId ? null : owners.ownerUserId,
    owners.backupUserId === current.backupUserId ? null : owners.backupUserId,
  ];
  for (const userId of changing) {
    if (userId !== null && !known.has(userId)) {
      throw new ServiceError("invalid", "That person is not a member");
    }
  }
};

export const createAgentsService = ({
  atomic,
  db,
  dropVaults,
  events,
  members,
}: {
  /** The multi-statement write port, for `changeRuntime`. Without it a runtime cannot change. */
  atomic?: Atomic;
  db: Database;
  /** Deletes managed session vaults on Anthropic's side, best effort, after `changeRuntime` closed their sessions. */
  dropVaults?: (workspaceId: string, vaultIds: string[]) => Promise<void>;
  events: EventsService;
  /** Who counts as a member, for `setOwners`. Without it owners cannot be set. */
  members?: Pick<MembersService, "list">;
}) => {
  const isSlugTaken = async (workspaceId: string, slug: string) => {
    const [row] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.slug, slug)))
      .limit(1);
    return row !== undefined;
  };

  const assertMachineInWorkspace = async (
    machineId: string,
    workspaceId: string
  ) => {
    const [row] = await db
      .select({ credentialHash: machines.credentialHash })
      .from(machines)
      .where(
        and(eq(machines.id, machineId), eq(machines.workspaceId, workspaceId))
      )
      .limit(1);
    if (!row) {
      throw new ServiceError(
        "invalid",
        `Machine ${machineId} is not in this workspace`
      );
    }
    if (!hasAgentHostRole(row.credentialHash)) {
      throw new ServiceError(
        "invalid",
        `Machine ${machineId} has no agent_host role, so it cannot run an agent`
      );
    }
  };

  const validateRuntime = async (
    parsed: z.output<typeof agentActivateSchema>,
    workspaceId: string
  ): Promise<string | null> => {
    assertRuntimeConfig(parsed.runtime, parsed.runtimeConfig);
    assertModelForRuntime(parsed.runtime, parsed.model);

    const machineId = parsed.machineId ?? null;
    if (parsed.runtime === "machine") {
      if (machineId === null) {
        throw new ServiceError("invalid", "A machine agent needs a machineId");
      }
      await assertMachineInWorkspace(machineId, workspaceId);
    } else if (machineId !== null) {
      throw new ServiceError(
        "invalid",
        `Only a machine agent takes a machineId, not "${parsed.runtime}"`
      );
    }

    return machineId;
  };

  const insertAgent = async (
    principal: Principal,
    input: AgentCreateInput,
    status: "active" | "draft"
  ): Promise<AgentRecord> => {
    const user = requireUser(principal, AGENT_CREATE);
    const parsed = agentCreateSchema.parse(input);
    const { workspaceId } = user;
    authorize(user, AGENT_CREATE, { kind: AGENT_KIND, workspaceId });
    const machineId = await validateRuntime(parsed, workspaceId);

    const base = resolveSlug(parsed.slug, parsed.name);
    const slug =
      status === "draft"
        ? await freeName(base, (candidate) =>
            isSlugTaken(workspaceId, candidate)
          )
        : base;
    if (status === "active" && (await isSlugTaken(workspaceId, slug))) {
      throw slugTaken(slug);
    }

    const id = ulid();
    await assertHandsTo(db, { handsTo: parsed.handsTo, id, workspaceId });
    const row: AgentRow = {
      askLevel: "rarely",
      backupUserId: null,
      computerMachineId: null,
      createdAt: new Date().toISOString(),
      createdBy: user.userId,
      emailLocal: null,
      handsTo: JSON.stringify(parsed.handsTo),
      id,
      instructions: parsed.instructions,
      machineId,
      model: parsed.model,
      name: parsed.name,
      ownerUserId: null,
      runtime: parsed.runtime,
      runtimeConfig: JSON.stringify(parsed.runtimeConfig),
      slug,
      soul: parsed.soul,
      status,
      subagents: false,
      workspaceId,
    };
    try {
      await db.insert(agents).values(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        if (status === "draft") {
          // Another builder may have taken the suggestion before the insert.
          return await insertAgent(principal, input, status);
        }
        throw slugTaken(slug);
      }
      throw error;
    }

    if (status === "active") {
      await events.append({
        actor: { id: user.userId, kind: "user" },
        agentId: row.id,
        payload: { name: row.name, runtime: row.runtime, slug },
        type: "agent.created",
        workspaceId,
      });
    }
    return toRecord(row);
  };

  const create = (principal: Principal, input: AgentCreateInput) =>
    insertAgent(principal, input, "active");

  const createDraft = async (principal: Principal, input: AgentDraftInput) => {
    const parsed = agentDraftSchema.parse(input);
    return await insertAgent(
      principal,
      {
        ...parsed,
        model: CLOUD_DEFAULT_MODEL,
        runtime: "cloud",
      },
      "draft"
    );
  };

  const get = async (
    principal: Principal,
    id: string
  ): Promise<AgentRecord> => {
    const workspaceId = readableWorkspace(principal, AGENT_READ);
    authorize(principal, AGENT_READ, { kind: AGENT_KIND, workspaceId });
    const agent = await findAgent(db, { id, workspaceId });
    if (!agent) {
      throw new ServiceError("not_found", "Agent not found");
    }
    return agent;
  };

  /** Global availability deliberately reveals only taken/free, never the owner. */
  const isAddressTaken = async (local: string): Promise<boolean> => {
    const [row] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.emailLocal, local))
      .limit(1);
    return row !== undefined;
  };

  const suggestAddress = async (slug: string): Promise<string> => {
    const base = slugSchema.parse(slug);
    return await freeName(
      base,
      async (candidate) =>
        RESERVED_ADDRESSES.has(candidate) || (await isAddressTaken(candidate))
    );
  };

  const checkAddress = async (principal: Principal, local: string) => {
    const workspaceId = readableWorkspace(principal, AGENT_READ);
    authorize(principal, AGENT_READ, { kind: AGENT_KIND, workspaceId });
    assertAddress(local);
    return { available: !(await isAddressTaken(local)) };
  };

  const reserveAddress = async (
    principal: Principal,
    agentId: string,
    local: string
  ) => {
    const user = requireUser(principal, AGENT_UPDATE);
    const current = await get(user, agentId);
    authorize(user, AGENT_UPDATE, {
      kind: AGENT_KIND,
      workspaceId: user.workspaceId,
    });
    assertAddress(local);
    // Retrying the same reservation on its owner is idempotent.
    if (current.emailLocal === local) {
      return current;
    }
    let row: AgentRow | undefined;
    try {
      [row] = await db
        .update(agents)
        .set({ emailLocal: local })
        .where(
          and(eq(agents.id, agentId), eq(agents.workspaceId, user.workspaceId))
        )
        .returning();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw addressTaken();
      }
      throw error;
    }
    if (!row) {
      throw new ServiceError("not_found", "Agent not found");
    }
    await events.append({
      actor: { id: user.userId, kind: "user" },
      agentId,
      payload: { emailLocal: local },
      type: "agent.address_reserved",
      workspaceId: user.workspaceId,
    });
    return toRecord(row);
  };

  const activate = async (
    principal: Principal,
    agentId: string,
    input: AgentActivateInput
  ) => {
    const user = requireUser(principal, AGENT_CREATE);
    const current = await get(user, agentId);
    authorize(user, AGENT_CREATE, {
      kind: AGENT_KIND,
      workspaceId: user.workspaceId,
    });
    const parsed = agentActivateSchema.parse(input);
    const machineId = await validateRuntime(parsed, user.workspaceId);
    // Lifecycle transitions only accept drafts, so a retry cannot reconfigure
    // an already active agent or append another agent.created event.
    const [row] = await db
      .update(agents)
      .set({
        machineId,
        model: parsed.model,
        runtime: parsed.runtime,
        runtimeConfig: JSON.stringify(parsed.runtimeConfig),
        status: "active",
      })
      .where(
        and(
          eq(agents.id, current.id),
          eq(agents.workspaceId, user.workspaceId),
          eq(agents.status, "draft")
        )
      )
      .returning();
    if (!row) {
      throw new ServiceError("invalid", "That agent is not a draft");
    }
    await events.append({
      actor: { id: user.userId, kind: "user" },
      agentId,
      payload: { name: row.name, runtime: row.runtime, slug: row.slug },
      type: "agent.created",
      workspaceId: user.workspaceId,
    });
    return toRecord(row);
  };

  const discardDraft = async (principal: Principal, agentId: string) => {
    const user = requireUser(principal, AGENT_ARCHIVE);
    const current = await get(user, agentId);
    authorize(user, AGENT_ARCHIVE, {
      kind: AGENT_KIND,
      workspaceId: user.workspaceId,
    });
    // Discard retries keep the archived row, its slug and all event references.
    if (current.status === "archived") {
      return current;
    }
    const [row] = await db
      .update(agents)
      .set({ status: "archived" })
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.workspaceId, user.workspaceId),
          eq(agents.status, "draft")
        )
      )
      .returning();
    if (!row) {
      throw new ServiceError("invalid", "That agent is not a draft");
    }
    await events.append({
      actor: { id: user.userId, kind: "user" },
      agentId,
      payload: { status: "archived" },
      type: "agent.updated",
      workspaceId: user.workspaceId,
    });
    return toRecord(row);
  };

  const list = async (
    principal: Principal,
    { includeArchived = false }: { includeArchived?: boolean } = {}
  ): Promise<AgentRecord[]> => {
    const workspaceId = readableWorkspace(principal, AGENT_READ);
    authorize(principal, AGENT_READ, { kind: AGENT_KIND, workspaceId });
    const rows = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          includeArchived
            ? ne(agents.status, "draft")
            : eq(agents.status, "active")
        )
      )
      .orderBy(asc(agents.name), asc(agents.id));
    return rows.map(toRecord);
  };

  /** The updated row, or undefined when none matched. A slug clash is a conflict. */
  const saveAgent = async (
    id: string,
    workspaceId: string,
    values: AgentValues,
    expectedRuntimeConfig?: string
  ): Promise<AgentRow | undefined> => {
    try {
      const [row] = await db
        .update(agents)
        .set(values)
        .where(
          and(
            eq(agents.id, id),
            eq(agents.workspaceId, workspaceId),
            expectedRuntimeConfig === undefined
              ? undefined
              : eq(agents.runtimeConfig, expectedRuntimeConfig)
          )
        )
        .returning();
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw slugTaken(values.slug);
      }
      throw error;
    }
  };

  /** A patch that sets machineId: only on a machine agent, and never to null. */
  const assertMachinePatch = async (
    runtime: AgentRuntime,
    machineId: string | null,
    workspaceId: string
  ) => {
    if (runtime !== "machine") {
      throw new ServiceError(
        "invalid",
        `Only a machine agent takes a machineId, not "${runtime}"`
      );
    }
    if (machineId === null) {
      throw new ServiceError("invalid", "A machine agent needs a machineId");
    }
    await assertMachineInWorkspace(machineId, workspaceId);
  };

  const assertAgentPatch = async (
    current: AgentRecord,
    parsed: z.output<typeof agentUpdateSchema>
  ): Promise<void> => {
    const { id, workspaceId } = current;
    if (parsed.runtimeConfig !== undefined) {
      assertRuntimeConfig(current.runtime, parsed.runtimeConfig);
    }
    if (parsed.model !== undefined) {
      assertModelForRuntime(current.runtime, parsed.model);
    }
    if (parsed.machineId !== undefined) {
      await assertMachinePatch(current.runtime, parsed.machineId, workspaceId);
    }

    if (parsed.handsTo !== undefined) {
      await assertHandsTo(db, { handsTo: parsed.handsTo, id, workspaceId });
    }
  };

  /**
   * `options.runtimeConfigPatch` sets single keys of the runtime config on top
   * of the stored one. The write then fails with a conflict when another
   * change to the config landed since it was read.
   */
  const update = async (
    principal: Principal,
    id: string,
    input: AgentUpdateInput,
    options: {
      runtimeConfigPatch?: Record<string, boolean | number | string>;
    } = {}
  ): Promise<AgentRecord> => {
    const user = requireUser(principal, AGENT_UPDATE);
    const { workspaceId } = user;
    authorize(user, AGENT_UPDATE, { kind: AGENT_KIND, workspaceId });
    const current = await findAgent(db, { id, workspaceId });
    if (!current) {
      throw new ServiceError("not_found", "Agent not found");
    }
    const { runtimeConfigPatch } = options;
    const parsed = agentUpdateSchema.parse(
      withConfigPatch(input, current, runtimeConfigPatch)
    );
    if (parsed.subagents !== undefined) {
      assertOwnerOrAdmin(user, current);
    }
    await assertAgentPatch(current, parsed);

    const slug = parsed.slug ?? current.slug;
    if (slug !== current.slug && (await isSlugTaken(workspaceId, slug))) {
      throw slugTaken(slug);
    }

    const values = {
      handsTo: JSON.stringify(parsed.handsTo ?? current.handsTo),
      instructions: parsed.instructions ?? current.instructions,
      machineId: parsed.machineId ?? current.machineId,
      model: parsed.model ?? current.model,
      name: parsed.name ?? current.name,
      runtimeConfig: JSON.stringify(
        parsed.runtimeConfig ?? current.runtimeConfig
      ),
      slug,
      soul: parsed.soul ?? current.soul,
      subagents: parsed.subagents ?? current.subagents,
    };
    const row = await saveAgent(
      id,
      workspaceId,
      values,
      runtimeConfigPatch && JSON.stringify(current.runtimeConfig)
    );
    if (!row) {
      throw unsavedAgent(runtimeConfigPatch);
    }

    await events.append({
      actor: { id: user.userId, kind: "user" },
      agentId: id,
      payload: {
        changed: Object.entries(parsed)
          .filter(([, value]) => value !== undefined)
          .map(([key]) => key),
      },
      type: "agent.updated",
      workspaceId,
    });
    return toRecord(row);
  };

  /**
   * Sets who the agent asks and who backs them up. Both must be current
   * members of the organisation, and they must be different people. A null
   * owner means the agent's creator, a null backup means no backup.
   */
  const setOwners = async (
    principal: Principal,
    id: string,
    input: AgentOwnersInput
  ): Promise<AgentRecord> => {
    const user = requireUser(principal, AGENT_UPDATE);
    const { workspaceId } = user;
    authorize(user, AGENT_UPDATE, { kind: AGENT_KIND, workspaceId });
    const owners = agentOwnersSchema.parse(input);
    const current = await findAgent(db, { id, workspaceId });
    if (!current) {
      throw new ServiceError("not_found", "Agent not found");
    }
    if (!members) {
      throw new ServiceError("invalid", "Members are not available here");
    }
    await assertOwners(user, members, current, owners);
    const changed = [
      ...(owners.ownerUserId === current.ownerUserId ? [] : ["ownerUserId"]),
      ...(owners.backupUserId === current.backupUserId ? [] : ["backupUserId"]),
    ];
    if (changed.length === 0) {
      return current;
    }
    const [row] = await db
      .update(agents)
      .set(owners)
      .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId)))
      .returning();
    if (!row) {
      throw new ServiceError("not_found", "Agent not found");
    }
    await events.append({
      actor: { id: user.userId, kind: "user" },
      agentId: id,
      payload: { changed },
      type: "agent.updated",
      workspaceId,
    });
    return toRecord(row);
  };

  /** The agent's values after a move to `parsed`, or a refusal when it cannot run there. */
  const validatedMove = async (
    current: AgentRecord,
    parsed: z.output<typeof agentRuntimeTargetSchema>
  ) => {
    const model = parsed.model ?? current.model;
    const machineId = parsed.machineId ?? null;
    if (
      parsed.runtime === current.runtime &&
      model === current.model &&
      machineId === current.machineId
    ) {
      throw new ServiceError(
        "invalid",
        `This agent already runs on "${current.runtime}"`
      );
    }
    const dropped = configKeysDroppedFor(parsed.runtime);
    const runtimeConfig = Object.fromEntries(
      Object.entries(current.runtimeConfig).filter(
        ([key]) => !dropped.includes(key)
      )
    );
    await validateRuntime(
      { machineId, model, runtime: parsed.runtime, runtimeConfig },
      current.workspaceId
    );
    if (parsed.runtime === "managed") {
      const [key] = await db
        .select({ workspaceId: workspaceAnthropicKeys.workspaceId })
        .from(workspaceAnthropicKeys)
        .where(eq(workspaceAnthropicKeys.workspaceId, current.workspaceId))
        .limit(1);
      if (!key) {
        throw new ServiceError("invalid", NO_KEY_MESSAGE);
      }
    }
    return { machineId, model, runtime: parsed.runtime, runtimeConfig };
  };

  /** Refuses a move while a run of the agent is live, and names the run. */
  const assertNoLiveRun = async (current: AgentRecord): Promise<void> => {
    const [live] = await db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(
        and(
          eq(runs.agentId, current.id),
          inArray(runs.status, [...LIVE_RUN_STATUSES])
        )
      )
      .limit(1);
    if (live) {
      throw new ServiceError(
        "conflict",
        `Run ${live.id} is ${live.status}. Wait for it to finish or cancel it, then move the agent.`
      );
    }
  };

  /**
   * Moves an agent to another runtime. Conversation context lives in the
   * runtime, so the agent's sessions start fresh: their runtime ref is
   * cleared, and leaving managed closes its sessions and drops their vaults.
   * Only the agent's owner or an org admin on a browser session may do it,
   * and not while a run of the agent is live.
   */
  const changeRuntime = async (
    principal: Principal,
    id: string,
    target: AgentRuntimeTarget
  ): Promise<AgentRecord> => {
    const user = requireUser(principal, AGENT_CHANGE_RUNTIME);
    const { workspaceId } = user;
    authorize(user, AGENT_CHANGE_RUNTIME, { kind: AGENT_KIND, workspaceId });
    const current = await findAgent(db, { id, workspaceId });
    if (!current) {
      throw new ServiceError("not_found", "Agent not found");
    }
    assertOwnerOrAdmin(user, current, AGENT_CHANGE_RUNTIME);
    if (!atomic) {
      throw new ServiceError(
        "invalid",
        "Moving an agent is not available here"
      );
    }
    const parsed = agentRuntimeTargetSchema.parse(target);
    if (current.status !== "active") {
      throw new ServiceError("invalid", "Only an active agent can be moved");
    }
    const next = await validatedMove(current, parsed);
    await assertNoLiveRun(current);

    const agentSessions = db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.agentId, id));
    const leavingManaged =
      current.runtime === "managed" && next.runtime !== "managed";
    const vaults = leavingManaged
      ? await db
          .select({ vaultId: managedSessions.vaultId })
          .from(managedSessions)
          .where(
            and(
              inArray(managedSessions.sessionId, agentSessions),
              isNull(managedSessions.closedAt)
            )
          )
      : [];
    await atomic([
      db
        .update(agents)
        .set({
          ...(next.runtime === "machine" ? { computerMachineId: null } : {}),
          machineId: next.machineId,
          model: next.model,
          runtime: next.runtime,
          runtimeConfig: JSON.stringify(next.runtimeConfig),
        })
        .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId))),
      db
        .update(sessions)
        .set({ runtimeMachineId: null, runtimeRef: null })
        .where(eq(sessions.agentId, id)),
      ...(leavingManaged
        ? [
            db
              .update(managedSessions)
              .set({ closedAt: new Date().toISOString() })
              .where(
                and(
                  inArray(managedSessions.sessionId, agentSessions),
                  isNull(managedSessions.closedAt)
                )
              ),
          ]
        : []),
    ]);
    if (dropVaults && vaults.length > 0) {
      try {
        await dropVaults(
          workspaceId,
          vaults.map((vault) => vault.vaultId)
        );
      } catch (error) {
        // The sessions are closed, so their tokens already fail. A vault left behind is clutter.
        console.error("Deleting managed session vaults failed:", error);
      }
    }
    await events.append({
      actor: { id: user.userId, kind: "user" },
      agentId: id,
      payload: {
        changed: changedByMove(current, next),
        from: current.runtime,
        to: next.runtime,
      },
      type: "agent.updated",
      workspaceId,
    });
    return await get(user, id);
  };

  const archive = async (
    principal: Principal,
    id: string
  ): Promise<AgentRecord> => {
    const user = requireUser(principal, AGENT_ARCHIVE);
    const { workspaceId } = user;
    authorize(user, AGENT_ARCHIVE, { kind: AGENT_KIND, workspaceId });
    const current = await findAgent(db, { id, workspaceId });
    if (!current) {
      throw new ServiceError("not_found", "Agent not found");
    }
    if (current.status === "archived") {
      return current;
    }

    // The status guard makes a concurrent archive write nothing, so only one
    // call appends the event.
    const [row] = await db
      .update(agents)
      .set({ status: "archived" })
      .where(
        and(
          eq(agents.id, id),
          eq(agents.workspaceId, workspaceId),
          eq(agents.status, "active")
        )
      )
      .returning();
    if (!row) {
      return (await findAgent(db, { id, workspaceId })) ?? current;
    }

    await events.append({
      actor: { id: user.userId, kind: "user" },
      agentId: id,
      payload: { status: "archived" },
      type: "agent.updated",
      workspaceId,
    });
    return toRecord(row);
  };

  const restore = async (
    principal: Principal,
    id: string
  ): Promise<AgentRecord> => {
    const user = requireUser(principal, AGENT_ARCHIVE);
    const { workspaceId } = user;
    authorize(user, AGENT_ARCHIVE, { kind: AGENT_KIND, workspaceId });
    const current = await get(user, id);
    if (current.status === "active") {
      return current;
    }
    if (current.status !== "archived") {
      throw new ServiceError("invalid", "That agent is not archived");
    }
    // Archived rows retain their reservations today. Check explicitly as well,
    // so restoration remains safe if reservations can be released in future.
    const [slugOwner] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          eq(agents.slug, current.slug),
          eq(agents.status, "active"),
          ne(agents.id, id)
        )
      )
      .limit(1);
    if (slugOwner) {
      throw slugTaken(current.slug);
    }
    if (current.emailLocal !== null) {
      const [addressOwner] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.emailLocal, current.emailLocal),
            eq(agents.status, "active"),
            ne(agents.id, id)
          )
        )
        .limit(1);
      if (addressOwner) {
        throw addressTaken();
      }
    }
    const [row] = await db
      .update(agents)
      .set({ status: "active" })
      .where(
        and(
          eq(agents.id, id),
          eq(agents.workspaceId, workspaceId),
          eq(agents.status, "archived")
        )
      )
      .returning();
    if (!row) {
      return await get(user, id);
    }
    await events.append({
      actor: { id: user.userId, kind: "user" },
      agentId: id,
      payload: { status: "active" },
      type: "agent.updated",
      workspaceId,
    });
    return toRecord(row);
  };

  return {
    activate,
    archive,
    changeRuntime,
    checkAddress,
    create,
    createDraft,
    discardDraft,
    get,
    list,
    reserveAddress,
    restore,
    setOwners,
    suggestAddress,
    update,
  };
};

export type AgentsService = ReturnType<typeof createAgentsService>;
