import type { Db } from "#/db/client";
import { hashMcpToken } from "#/modules/agents/mcp-token";
import type { Agent } from "#/modules/agents/schema";
import {
  getAgentByIdUnscoped,
  listAgentIdsForComputerHost,
  setAgentComputerRef,
} from "#/modules/agents/service";
import {
  createFlyGateway,
  type FlyGateway,
  type FlyGatewayFactory,
  type FlyMachineConfig,
} from "./fly-gateway";
import {
  getHostByIdUnscoped,
  resolveFlyApiToken,
  resolveHostToken,
  setHostStatus,
} from "./hosts";
import type { ComputerHost } from "./schema";

/**
 * What an agent's computer backend has to create when the agent appears and
 * destroy when it goes - which today means Fly, since the Durable Object is
 * addressed by the agent id and a self-hosted container belongs to the user.
 *
 * Everything here is best-effort and nothing here throws. The agent row is D1
 * and this is a third party's API, so a Fly outage must not be able to fail a
 * creation or a deletion the user asked for. A failure is recorded on the host
 * row (`status: "error"` plus the reason, naming the agent), because that is
 * the one screen a person looks at when a computer misbehaves; the agent side
 * already refuses every operation with "no machine has been created for this
 * agent yet", which is the other half of the same story.
 *
 * **Unverified against a real account**: no Fly call below has ever been made.
 * The payloads follow docs/plan-computer-backends.md §5 and Fly's Machines API
 * documentation; see `fly-gateway.ts`.
 */

/** Where the volume is mounted, and the root the daemon serves paths from. */
const COMPUTER_ROOT = "/home/agent";

/** The image the plan ships; a host may name its own. */
const DEFAULT_IMAGE = "ghcr.io/codewithpassion/agentum-computerd:latest";

const DEFAULT_VOLUME_GB = 10;
const DEFAULT_CPUS = 1;
const DEFAULT_MEMORY_MB = 512;
const DAEMON_PORT = 8080;
const HTTPS_PORT = 443;

/**
 * Fly volume names are short and alphanumeric, so the agent's UUID is stripped
 * of its dashes and truncated: `agent_` plus 24 hex characters is 30, the
 * documented maximum. Two agents cannot collide - the truncation keeps the
 * first 24 of 32 hex digits, which is 96 bits of a v4 UUID.
 */
const VOLUME_NAME_HEX = 24;

const idSuffix = (agentId: string): string =>
  agentId.replaceAll("-", "").slice(0, VOLUME_NAME_HEX);

const volumeNameFor = (agentId: string): string => `agent_${idSuffix(agentId)}`;

/** Only so a person reading the Fly dashboard can tell the machines apart. */
const machineNameFor = (agentId: string): string =>
  `agent-${idSuffix(agentId)}`;

/**
 * The machine the plan describes (§5): the computerd image in listen mode, the
 * agent's volume on `/home/agent`, and one service on 443 that Fly's proxy
 * starts on the first request and stops again when the agent goes idle - which
 * is why nothing in the hot path ever calls start or stop.
 *
 * The daemon is given the token's *hash*: it compares what each caller presents
 * against it, and never holds the plaintext.
 */
const machineConfigFor = (
  host: ComputerHost,
  volumeId: string,
  tokenHash: string
): FlyMachineConfig => ({
  env: {
    COMPUTERD_MODE: "listen",
    COMPUTERD_TOKEN_HASH: tokenHash,
  },
  guest: {
    cpu_kind: "shared",
    cpus: host.config.instance?.cpus ?? DEFAULT_CPUS,
    memory_mb: host.config.instance?.memory_mb ?? DEFAULT_MEMORY_MB,
  },
  image: host.config.image ?? DEFAULT_IMAGE,
  mounts: [{ path: COMPUTER_ROOT, volume: volumeId }],
  services: [
    {
      autostart: true,
      autostop: "stop",
      internal_port: DAEMON_PORT,
      ports: [{ handlers: ["tls", "http"], port: HTTPS_PORT }],
      protocol: "tcp",
    },
  ],
});

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown error.";

/** Everything a Fly call needs, or the reason it cannot be made. */
interface FlyContext {
  app: string;
  gateway: FlyGateway;
  host: ComputerHost;
}

const flyContextFor = async (
  env: Env,
  host: ComputerHost,
  createGateway: FlyGatewayFactory
): Promise<FlyContext> => {
  if (host.kind !== "fly") {
    throw new Error(`The computer host is a ${host.kind} host.`);
  }
  if (!host.config.app) {
    throw new Error("The computer host has no Fly app configured.");
  }
  const apiToken = await resolveFlyApiToken(env, host);
  if (!apiToken) {
    throw new Error(
      "The computer host has no Fly API token stored. Add one in Settings."
    );
  }
  return { app: host.config.app, gateway: createGateway(apiToken), host };
};

/** The host an agent's computer sits on, or nothing to do. */
const flyHostOf = async (
  db: Db,
  agent: Agent
): Promise<ComputerHost | undefined> =>
  agent.computerHostId
    ? await getHostByIdUnscoped(db, agent.computerHostId)
    : undefined;

/**
 * Volume first, machine second, and the ids written after each: a provision
 * that dies between the two leaves a volume the teardown can still find, rather
 * than an orphan only the Fly dashboard knows about.
 *
 * The region is passed through as the host configured it. Absent, Fly uses the
 * app's primary region, which is its documented default and a better answer
 * than one this code guessed.
 */
const provisionFlyComputer = async (
  db: Db,
  env: Env,
  agent: Agent,
  context: FlyContext
): Promise<void> => {
  const { app, gateway, host } = context;
  const tokenHash = await hashMcpToken(await resolveHostToken(db, env, host));

  const volume = await gateway.createVolume(app, {
    name: volumeNameFor(agent.id),
    sizeGb: host.config.volume_gb ?? DEFAULT_VOLUME_GB,
    ...(host.config.region === undefined ? {} : { region: host.config.region }),
  });
  await setAgentComputerRef(db, agent.id, { volumeId: volume.id });

  const machine = await gateway.createMachine(app, {
    config: machineConfigFor(host, volume.id, tokenHash),
    name: machineNameFor(agent.id),
    ...(host.config.region === undefined ? {} : { region: host.config.region }),
  });
  await setAgentComputerRef(db, agent.id, {
    machineId: machine.id,
    volumeId: volume.id,
  });
};

/**
 * The computer an agent was created with, brought into existence. Called from
 * the agents create route in the background, the way the Anthropic
 * registration is: creating a Fly machine takes seconds the user should not
 * spend staring at a dialog, and the agent is usable for everything else
 * meanwhile.
 */
export const onAgentComputerCreated = async (
  db: Db,
  env: Env,
  agent: Agent,
  createGateway: FlyGatewayFactory = createFlyGateway
): Promise<void> => {
  if (agent.computer !== "fly") {
    // `cloudflare`: the Durable Object springs into being on first use.
    // `self_hosted`: the container is already running on the user's machine.
    return;
  }

  const host = await flyHostOf(db, agent);
  if (!host) {
    // A host that is already gone leaves nowhere to record anything, and the
    // agent's own computer already refuses with the same news.
    return;
  }

  try {
    await provisionFlyComputer(
      db,
      env,
      agent,
      await flyContextFor(env, host, createGateway)
    );
  } catch (error) {
    await setHostStatus(
      db,
      host.id,
      "error",
      `Could not create the computer for "${agent.name}": ${messageOf(error)}`
    );
  }
};

/** Runs `work`, and records what it was trying to do if it fails. */
const attempt = async (
  failures: string[],
  what: string,
  work: () => Promise<unknown>
): Promise<void> => {
  try {
    await work();
  } catch (error) {
    failures.push(`${what} (${messageOf(error)})`);
  }
};

/**
 * What a deleted agent leaves behind on its computer backend, and whose job it
 * is to clear it. Called from the agents delete route with the row as it was
 * just before deletion - `computer`, `computerHostId` and `computerRef` are
 * all still on it, which is the only reason the call is placed there and not
 * after.
 *
 * Deliberately not part of `deleteAgent`: the agent row is D1 and this is a
 * third party's API, so a Fly outage must not be able to fail a deletion the
 * user asked for. Failures leave orphans, and the reason lands on the host so
 * a person can go and delete them by hand.
 */
export const onAgentComputerDeleted = async (
  db: Db,
  env: Env,
  agent: Agent,
  createGateway: FlyGatewayFactory = createFlyGateway
): Promise<void> => {
  if (agent.computer !== "fly") {
    // `cloudflare`: the Durable Object is addressed by the agent id, so a
    // deleted agent's computer is simply never reached again.
    // `self_hosted`: the container and its volume are the user's, on the
    // user's machine. Nothing here may touch them.
    return;
  }
  const machineId = agent.computerRef?.machineId;
  const volumeId = agent.computerRef?.volumeId;
  if (!(machineId || volumeId)) {
    // Nothing was ever created - a provision that failed at the first call.
    return;
  }

  const host = await flyHostOf(db, agent);
  if (!host) {
    // The host went first, taking the only credential that could have deleted
    // these. Nothing to call, and nowhere left to say so.
    return;
  }

  const failures: string[] = [];
  let context: FlyContext;
  try {
    context = await flyContextFor(env, host, createGateway);
  } catch (error) {
    await setHostStatus(
      db,
      host.id,
      "error",
      `"${agent.name}" was deleted, but its Fly machine could not be removed: ${messageOf(error)}`
    );
    return;
  }

  const { app, gateway } = context;
  if (machineId) {
    // Stopped first so the machine is not killed mid-write; `force` because a
    // machine that would not stop must still not survive its agent, and Fly
    // refuses to delete a volume that is still attached to one.
    await attempt(failures, "stop the machine", () =>
      gateway.stopMachine(app, machineId)
    );
    await attempt(failures, "delete the machine", () =>
      gateway.deleteMachine(app, machineId, { force: true })
    );
  }
  if (volumeId) {
    await attempt(failures, "delete the volume", () =>
      gateway.deleteVolume(app, volumeId)
    );
  }

  if (failures.length > 0) {
    await setHostStatus(
      db,
      host.id,
      "error",
      `"${agent.name}" was deleted, but Fly would not ${failures.join(", nor ")}. Remove them in the Fly dashboard.`
    );
  }
};

/**
 * A machine's config with one env var replaced. The rest is sent back exactly
 * as Fly handed it over: an update replaces the whole config, so anything
 * dropped here would be dropped from the machine.
 */
const withTokenHash = (
  config: Record<string, unknown> | null,
  tokenHash: string
): FlyMachineConfig => {
  if (!config) {
    throw new Error("Fly did not return the machine's current configuration.");
  }
  if (typeof config.image !== "string") {
    throw new Error("Fly did not return the machine's image.");
  }
  const env =
    typeof config.env === "object" && config.env !== null ? config.env : {};
  // Cast rather than rebuilt: a machine config has fields this app does not
  // model, and every one of them has to survive the round trip.
  return {
    ...config,
    env: { ...env, COMPUTERD_TOKEN_HASH: tokenHash },
    image: config.image,
  } as unknown as FlyMachineConfig;
};

const updateMachineToken = async (
  db: Db,
  context: FlyContext,
  agentId: string,
  tokenHash: string
): Promise<void> => {
  const agent = await getAgentByIdUnscoped(db, agentId);
  const machineId = agent?.computerRef?.machineId;
  if (!machineId) {
    // Nothing was provisioned for this agent, so there is nothing holding the
    // old hash either.
    return;
  }
  const machine = await context.gateway.getMachine(context.app, machineId);
  await context.gateway.updateMachine(
    context.app,
    machineId,
    withTokenHash(machine.config, tokenHash)
  );
};

/**
 * A rotated Fly host token, pushed to every machine on the host. Until this
 * runs, the machines still check against the old hash and every request this
 * server makes with the new token would be refused - so the rotation is only
 * really finished here.
 *
 * Best-effort like the rest of this file: a machine that could not be updated
 * is named on the host's status rather than failing the owner's rotation.
 */
export const onFlyHostTokenRotated = async (
  db: Db,
  env: Env,
  host: ComputerHost,
  createGateway: FlyGatewayFactory = createFlyGateway
): Promise<void> => {
  if (host.kind !== "fly") {
    return;
  }
  try {
    const context = await flyContextFor(env, host, createGateway);
    const tokenHash = await hashMcpToken(await resolveHostToken(db, env, host));
    const agentIds = await listAgentIdsForComputerHost(db, host.id);
    const outcomes = await Promise.allSettled(
      agentIds.map((agentId) =>
        updateMachineToken(db, context, agentId, tokenHash)
      )
    );
    const failed = outcomes.filter((outcome) => outcome.status === "rejected");
    if (failed.length > 0) {
      await setHostStatus(
        db,
        host.id,
        "error",
        `The new token did not reach ${failed.length} of this host's ${agentIds.length} machines: ${messageOf(failed[0]?.reason)}`
      );
    }
  } catch (error) {
    await setHostStatus(
      db,
      host.id,
      "error",
      `The new token did not reach this host's machines: ${messageOf(error)}`
    );
  }
};
