import { and, asc, eq, gt, isNull } from "drizzle-orm";
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
import type { HelloMessage } from "./protocol";
import {
  type ComputerHost,
  type ComputerHostConfig,
  type ComputerHostKind,
  type ComputerHostStatus,
  computerEnrollments,
  computerHosts,
} from "./schema";

/**
 * Computer hosts: creating them, describing them, and - in the one function
 * allowed to decrypt it - resolving the token a Fly host's transport presents.
 *
 * Every credential here is write-only from the outside. A self-hosted client
 * gets an enrollment code once, in the create or re-enroll response, and trades
 * it for a machine credential at `POST /api/computer-hosts/enroll`; only
 * SHA-256 hashes of either are stored. The Fly daemon token is never shown at
 * all, because Agentum is the side that presents it; the Fly API token comes
 * back as four characters. Nothing here logs any of them, and nothing here puts
 * one in an error message.
 */

const HINT_LENGTH = 4;
/** How long an enrollment code stays redeemable. */
export const ENROLLMENT_CODE_TTL_MS = 15 * 60 * 1000;

/** Everything a client may know about a host: never a hash or a ciphertext. */
export interface HostView {
  /** The agents whose computer runs on this host. */
  agentIds: string[];
  arch: string | null;
  capabilities: Record<string, unknown> | null;
  config: ComputerHostConfig;
  createdAt: Date;
  /** The Fly API token's last four characters, or null. */
  flyApiTokenHint: string | null;
  id: string;
  kind: ComputerHostKind;
  lastSeenAt: Date | null;
  name: string;
  os: string | null;
  protocolVersion: number | null;
  status: ComputerHostStatus;
  statusError: string | null;
}

export const toHostView = (
  host: ComputerHost,
  agentIds: string[]
): HostView => ({
  agentIds,
  arch: host.arch,
  capabilities: host.capabilities,
  config: host.config,
  createdAt: host.createdAt,
  flyApiTokenHint: host.flyApiTokenHint,
  id: host.id,
  kind: host.kind,
  lastSeenAt: host.lastSeenAt,
  name: host.name,
  os: host.os,
  protocolVersion: host.protocolVersion,
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
 * Resolves the client's WebSocket upgrade to its host; undefined means "not a
 * host". Global by design, exactly like `findAgentByMcpToken`: the machine
 * credential is presented before any workspace is known.
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
 * The plaintext enrollment code, and the only moment it exists - for a
 * self-hosted host. A Fly host's token is stored encrypted and never handed
 * out, so `enrollmentCode` is null there and the client has nothing to show.
 */
export interface IssuedHost {
  enrollmentCode: string | null;
  host: ComputerHost;
}

/**
 * Fly machines are dialled *out* to, so Agentum keeps the daemon token
 * plaintext-under-encryption and presents it. Self-hosted clients dial in with
 * a machine credential minted at enrollment, so nothing is stored for them
 * until then.
 */
const flyTokenColumns = async (
  env: Env,
  kind: ComputerHostKind
): Promise<{ tokenEnc: string | null }> => ({
  tokenEnc:
    kind === "fly"
      ? await encryptSecret(requireConnectorKey(env), generateMcpToken())
      : null,
});

const flyApiTokenColumns = async (
  env: Env,
  flyApiToken: string
): Promise<{ flyApiTokenEnc: string; flyApiTokenHint: string }> => ({
  flyApiTokenEnc: await encryptSecret(requireConnectorKey(env), flyApiToken),
  flyApiTokenHint: flyApiToken.slice(-HINT_LENGTH),
});

/**
 * Mints a code for the host and returns it in plaintext, once. Any code the
 * host still holds unredeemed is deleted first, so there is only ever one live
 * way in.
 */
export const issueEnrollmentCode = async (
  db: Db,
  host: Pick<ComputerHost, "id" | "workspaceId">
): Promise<string> => {
  const code = generateMcpToken();
  await db
    .delete(computerEnrollments)
    .where(
      and(
        eq(computerEnrollments.hostId, host.id),
        isNull(computerEnrollments.redeemedAt)
      )
    );
  await db.insert(computerEnrollments).values({
    codeHash: await hashMcpToken(code),
    expiresAt: new Date(Date.now() + ENROLLMENT_CODE_TTL_MS),
    hostId: host.id,
    id: crypto.randomUUID(),
    workspaceId: host.workspaceId,
  });
  return code;
};

export interface RedeemedEnrollment {
  /** The plaintext machine credential; the caller's one chance to hand it out. */
  credential: string;
  host: ComputerHost;
}

/**
 * Trades a code for a machine credential. Undefined for every failure - wrong,
 * expired, already used - because the caller must not learn which.
 *
 * The conditional UPDATE is the lock: two concurrent redemptions of the same
 * code both see `redeemed_at IS NULL` in their WHERE, and SQLite lets exactly
 * one of them write.
 */
export const redeemEnrollmentCode = async (
  db: Db,
  code: string
): Promise<RedeemedEnrollment | undefined> => {
  const credential = generateMcpToken();
  const credentialHash = await hashMcpToken(credential);
  const now = new Date();

  const [claimed] = await db
    .update(computerEnrollments)
    .set({ redeemedAt: now, redeemedCredentialHash: credentialHash })
    .where(
      and(
        eq(computerEnrollments.codeHash, await hashMcpToken(code)),
        isNull(computerEnrollments.redeemedAt),
        gt(computerEnrollments.expiresAt, now)
      )
    )
    .returning({ hostId: computerEnrollments.hostId });
  if (!claimed) {
    return;
  }

  const [host] = await db
    .update(computerHosts)
    .set({
      status: "unconfigured",
      statusError: null,
      tokenHash: credentialHash,
      updatedAt: now,
    })
    .where(eq(computerHosts.id, claimed.hostId))
    .returning();
  return host ? { credential, host } : undefined;
};

export const createHost = async (
  db: Db,
  env: Env,
  workspaceId: string,
  input: CreateHostInput
): Promise<IssuedHost> => {
  const [host] = await db
    .insert(computerHosts)
    .values({
      config: input.config,
      id: crypto.randomUUID(),
      kind: input.kind,
      name: input.name,
      workspaceId,
      ...(await flyTokenColumns(env, input.kind)),
      ...(input.flyApiToken
        ? await flyApiTokenColumns(env, input.flyApiToken)
        : {}),
    })
    .returning();
  if (!host) {
    throw new Error("Failed to create the computer host.");
  }
  return {
    enrollmentCode:
      host.kind === "fly" ? null : await issueEnrollmentCode(db, host),
    host,
  };
};

export interface UpdateHostInput {
  config?: ComputerHostConfig;
  flyApiToken?: string;
  name?: string;
  /**
   * Self-hosted: drops the machine credential and issues a fresh enrollment
   * code, returned once. The client stays disconnected until it enrolls again.
   */
  reenroll?: boolean;
  /**
   * Fly only: re-encrypts a fresh daemon token; the machines' env has to be
   * updated with the new hash (track 3).
   */
  rotateToken?: boolean;
}

/**
 * `updatedAt` is written explicitly: the column default fires on insert only,
 * and every edit here has to move the date the settings page shows.
 *
 * A re-enrollment or rotation puts the host back to `unconfigured` - the old
 * credential is gone and nothing has proved the new one works yet, which is
 * exactly what the status is for.
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
    ? await flyTokenColumns(env, existing.kind)
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
        ? { status: "unconfigured" as const, statusError: null, ...rotated }
        : {}),
      ...(input.reenroll
        ? {
            status: "unconfigured" as const,
            statusError: null,
            tokenHash: null,
          }
        : {}),
    })
    .where(
      and(eq(computerHosts.workspaceId, workspaceId), eq(computerHosts.id, id))
    )
    .returning();
  if (!host) {
    return;
  }
  return {
    enrollmentCode: input.reenroll ? await issueEnrollmentCode(db, host) : null,
    host,
  };
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
  await db
    .delete(computerEnrollments)
    .where(
      and(
        eq(computerEnrollments.workspaceId, workspaceId),
        eq(computerEnrollments.hostId, id)
      )
    );
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

/** What the daemon said about the machine in its hello. Written once per connection. */
export const setHostHello = async (
  db: Db,
  id: string,
  hello: HelloMessage
): Promise<void> => {
  await db
    .update(computerHosts)
    .set({
      arch: hello.arch,
      capabilities: hello.capabilities,
      os: hello.os,
      protocolVersion: hello.protocol_version,
    })
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
