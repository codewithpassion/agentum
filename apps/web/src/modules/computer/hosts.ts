import { and, asc, eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "#/crypto";
import type { Db } from "#/db/client";
import {
  generateMcpToken,
  hashMcpToken,
  timingSafeEqual,
} from "#/modules/agents/mcp-token";
import {
  listAgentIdsByComputerHost,
  listAgentIdsForComputerHost,
} from "#/modules/agents/service";
import {
  type ComputerHost,
  type ComputerHostConfig,
  type ComputerHostKind,
  type ComputerHostStatus,
  computerHosts,
} from "./schema";

/**
 * Computer hosts: creating them, describing them, and - in the one function
 * allowed to decrypt it - resolving the token a Fly host's transport presents.
 *
 * Both credentials on a host row are write-only from the outside. The
 * self-hosted daemon token exists in plaintext exactly once, in the create or
 * rotate response; the Fly daemon token is never shown at all, because Agentum
 * is the side that presents it; the Fly API token comes back as four
 * characters. Nothing here logs any of them, and nothing here puts one in an
 * error message.
 */

const HINT_LENGTH = 4;

/** Everything a client may know about a host: never a hash or a ciphertext. */
export interface HostView {
  /** The agents whose computer runs on this host. */
  agentIds: string[];
  config: ComputerHostConfig;
  createdAt: Date;
  /** The Fly API token's last four characters, or null. */
  flyApiTokenHint: string | null;
  id: string;
  kind: ComputerHostKind;
  lastSeenAt: Date | null;
  name: string;
  status: ComputerHostStatus;
  statusError: string | null;
}

export const toHostView = (
  host: ComputerHost,
  agentIds: string[]
): HostView => ({
  agentIds,
  config: host.config,
  createdAt: host.createdAt,
  flyApiTokenHint: host.flyApiTokenHint,
  id: host.id,
  kind: host.kind,
  lastSeenAt: host.lastSeenAt,
  name: host.name,
  status: host.status,
  statusError: host.statusError,
});

/**
 * `CONNECTOR_KEY` is unset, so there is nothing to encrypt or decrypt with.
 * Typed so a route can answer "the deployment is not configured" rather than
 * turning a missing secret into a 500, the way the Anthropic key does.
 */
export class MissingComputerKeyError extends Error {
  constructor() {
    super(
      "CONNECTOR_KEY is not configured. Set it (a base64 32-byte key) before adding a Fly computer host."
    );
  }
}

/** A host that still has agents on it; deleting it would strand their files. */
export class ComputerHostInUseError extends Error {
  constructor(agentCount: number) {
    super(
      `This host still runs ${agentCount} agent${agentCount === 1 ? "" : "s"}. Delete them first.`
    );
  }
}

const requireConnectorKey = (env: Env): string => {
  if (!env.CONNECTOR_KEY) {
    throw new MissingComputerKeyError();
  }
  return env.CONNECTOR_KEY;
};

export const listHosts = async (
  db: Db,
  workspaceId: string
): Promise<{ agentIds: string[]; host: ComputerHost }[]> => {
  const [hosts, byHost] = await Promise.all([
    db
      .select()
      .from(computerHosts)
      .where(eq(computerHosts.workspaceId, workspaceId))
      .orderBy(asc(computerHosts.name)),
    listAgentIdsByComputerHost(db, workspaceId),
  ]);
  return hosts.map((host) => ({ agentIds: byHost.get(host.id) ?? [], host }));
};

export const getHost = async (
  db: Db,
  workspaceId: string,
  id: string
): Promise<ComputerHost | undefined> => {
  const [host] = await db
    .select()
    .from(computerHosts)
    .where(
      and(eq(computerHosts.workspaceId, workspaceId), eq(computerHosts.id, id))
    );
  return host;
};

/**
 * A host by bare id, for the server-side plumbing that derives everything from
 * the agent row it started with - the computer dispatcher, which was handed an
 * agent that already carries the host id.
 *
 * Never call this from a workspace-scoped route: `getHost` is the one that
 * answers "not found" for another tenant's id.
 */
export const getHostByIdUnscoped = async (
  db: Db,
  id: string
): Promise<ComputerHost | undefined> => {
  const [host] = await db
    .select()
    .from(computerHosts)
    .where(eq(computerHosts.id, id));
  return host;
};

/**
 * Resolves the daemon's WebSocket upgrade to its host; undefined means "not a
 * host". Global by design, exactly like `findAgentByMcpToken`: the token is a
 * credential presented before any workspace is known.
 */
export const findHostByToken = async (
  db: Db,
  token: string
): Promise<ComputerHost | undefined> => {
  const hash = await hashMcpToken(token);
  const [host] = await db
    .select()
    .from(computerHosts)
    .where(eq(computerHosts.tokenHash, hash));
  if (!(host?.tokenHash && timingSafeEqual(host.tokenHash, hash))) {
    return;
  }
  return host;
};

export interface CreateHostInput {
  config: ComputerHostConfig;
  /** Fly only; the caller validates it against the Machines API first. */
  flyApiToken?: string;
  kind: ComputerHostKind;
  name: string;
}

/**
 * The plaintext daemon token, and the only moment it exists - for a
 * self-hosted host. A Fly host's token is stored encrypted and never handed
 * out, so `token` is null there and the client has nothing to show.
 */
export interface IssuedHost {
  host: ComputerHost;
  token: string | null;
}

/**
 * Which column the daemon token lands in, and whether the caller gets to see
 * it, is decided entirely by the direction the token travels (see the plan,
 * §3): self-hosted daemons dial *in* and present it, so we keep a hash; Fly
 * machines are dialled *out* to, so we keep the plaintext encrypted.
 */
const tokenColumnsFor = async (
  env: Env,
  kind: ComputerHostKind,
  token: string
): Promise<{
  issued: string | null;
  tokenEnc: string | null;
  tokenHash: string | null;
}> => {
  if (kind === "self_hosted") {
    return {
      issued: token,
      tokenEnc: null,
      tokenHash: await hashMcpToken(token),
    };
  }
  return {
    issued: null,
    tokenEnc: await encryptSecret(requireConnectorKey(env), token),
    tokenHash: null,
  };
};

const flyApiTokenColumns = async (
  env: Env,
  flyApiToken: string
): Promise<{ flyApiTokenEnc: string; flyApiTokenHint: string }> => ({
  flyApiTokenEnc: await encryptSecret(requireConnectorKey(env), flyApiToken),
  flyApiTokenHint: flyApiToken.slice(-HINT_LENGTH),
});

export const createHost = async (
  db: Db,
  env: Env,
  workspaceId: string,
  input: CreateHostInput
): Promise<IssuedHost> => {
  const { issued, tokenEnc, tokenHash } = await tokenColumnsFor(
    env,
    input.kind,
    generateMcpToken()
  );

  const [host] = await db
    .insert(computerHosts)
    .values({
      config: input.config,
      id: crypto.randomUUID(),
      kind: input.kind,
      name: input.name,
      tokenEnc,
      tokenHash,
      workspaceId,
      ...(input.flyApiToken
        ? await flyApiTokenColumns(env, input.flyApiToken)
        : {}),
    })
    .returning();
  if (!host) {
    throw new Error("Failed to create the computer host.");
  }
  return { host, token: issued };
};

export interface UpdateHostInput {
  config?: ComputerHostConfig;
  flyApiToken?: string;
  name?: string;
  /**
   * Issues a fresh daemon token. Self-hosted: returned once, and the daemon
   * stays disconnected until it is restarted with it. Fly: re-encrypted, and
   * the machines' env has to be updated with the new hash (track 3).
   */
  rotateToken?: boolean;
}

/**
 * `updatedAt` is written explicitly: the column default fires on insert only,
 * and every edit here has to move the date the settings page shows.
 *
 * A rotation puts the host back to `unconfigured` - the old credential is gone
 * and nothing has proved the new one works yet, which is exactly what the
 * status is for.
 */
export const updateHost = async (
  db: Db,
  env: Env,
  workspaceId: string,
  id: string,
  input: UpdateHostInput
): Promise<IssuedHost | undefined> => {
  const existing = await getHost(db, workspaceId, id);
  if (!existing) {
    return;
  }

  const rotated = input.rotateToken
    ? await tokenColumnsFor(env, existing.kind, generateMcpToken())
    : null;

  const [host] = await db
    .update(computerHosts)
    .set({
      updatedAt: new Date(),
      ...(input.config === undefined ? {} : { config: input.config }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.flyApiToken
        ? await flyApiTokenColumns(env, input.flyApiToken)
        : {}),
      ...(rotated
        ? {
            status: "unconfigured" as const,
            statusError: null,
            tokenEnc: rotated.tokenEnc,
            tokenHash: rotated.tokenHash,
          }
        : {}),
    })
    .where(
      and(eq(computerHosts.workspaceId, workspaceId), eq(computerHosts.id, id))
    )
    .returning();

  return host ? { host, token: rotated?.issued ?? null } : undefined;
};

/**
 * Refused while any agent still points at the host: on Fly its machine and
 * volume would be orphaned, and on either kind the agent's computer would
 * silently stop resolving. The agents go first.
 */
export const deleteHost = async (
  db: Db,
  workspaceId: string,
  id: string
): Promise<boolean> => {
  const agentIds = await listAgentIdsForComputerHost(db, id);
  if (agentIds.length > 0) {
    throw new ComputerHostInUseError(agentIds.length);
  }
  const deleted = await db
    .delete(computerHosts)
    .where(
      and(eq(computerHosts.workspaceId, workspaceId), eq(computerHosts.id, id))
    )
    .returning({ id: computerHosts.id });
  return deleted.length > 0;
};

/**
 * What a ping, a connect or a heartbeat learned. Unscoped: the relay and the
 * transports know a host id and nothing else, and a status is not a secret.
 * `updatedAt` stays put - this is activity, not an edit.
 */
export const setHostStatus = async (
  db: Db,
  id: string,
  status: ComputerHostStatus,
  statusError?: string
): Promise<void> => {
  await db
    .update(computerHosts)
    .set({ status, statusError: statusError ?? null })
    .where(eq(computerHosts.id, id));
};

/** The daemon answered, so it was alive just now. */
export const touchHostSeen = async (db: Db, id: string): Promise<void> => {
  await db
    .update(computerHosts)
    .set({ lastSeenAt: new Date() })
    .where(eq(computerHosts.id, id));
};

/**
 * The only place a Fly host's daemon token is decrypted, and the reason
 * `token_enc` exists at all: the HTTP transport is the client, so it has to
 * present the plaintext on every request.
 *
 * Self-hosted hosts never reach this - the daemon holds their plaintext and we
 * hold only the hash - so asking for one is a programming error, not a
 * configuration one.
 */
export const resolveHostToken = async (
  db: Db,
  env: Env,
  host: ComputerHost
): Promise<string> => {
  if (host.kind !== "fly") {
    throw new Error(
      `Host ${host.id} is ${host.kind}: its daemon token is never held in plaintext here.`
    );
  }
  // Re-read rather than trusting the row the caller is holding: a rotation
  // between that read and this one would otherwise present the retired token.
  const current = (await getHostByIdUnscoped(db, host.id)) ?? host;
  if (!current.tokenEnc) {
    throw new Error(
      `Host ${host.id} has no daemon token stored. Rotate the host's token to issue one.`
    );
  }
  return await decryptSecret(requireConnectorKey(env), current.tokenEnc);
};

/**
 * The one Fly secret track 3 needs and nothing else may read. Separate from
 * `resolveHostToken` because they are different credentials with different
 * blast radii: this one can create and destroy machines.
 */
export const resolveFlyApiToken = async (
  env: Env,
  host: ComputerHost
): Promise<string | null> =>
  host.flyApiTokenEnc
    ? await decryptSecret(requireConnectorKey(env), host.flyApiTokenEnc)
    : null;
