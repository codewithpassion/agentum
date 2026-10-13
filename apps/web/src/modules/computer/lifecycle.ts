import type { Db } from "#/db/client";
import type { Agent } from "#/modules/agents/schema";
import { setAgentComputerRef } from "#/modules/agents/service";
import {
  createFlyGateway,
  type FlyGateway,
  type FlyGatewayFactory,
  type FlyMachineConfig,
} from "./fly-gateway";
import {
  FLY_ENROLLMENT_CODE_TTL_MS,
  getHostByIdUnscoped,
  issueEnrollmentCode,
  resolveFlyApiToken,
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

/**
 * Where the volume is mounted: the client's state dir, which holds its
 * credential and, by default, the per-agent session directories (the client's
 * workdir defaults to `<state-dir>/sessions`), so both survive a restart.
 */
const COMPUTER_STATE_DIR = "/var/lib/agentum-computer";

/** The image the plan ships; a host may name its own. */
const DEFAULT_IMAGE = "ghcr.io/codewithpassion/agentum-computer:latest";

const DEFAULT_VOLUME_GB = 10;
const DEFAULT_CPUS = 1;
const DEFAULT_MEMORY_MB = 512;

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
 * The machine: the client image in connect mode, the agent's volume on its
 * state dir, and nothing else. No service and no port, because the client dials
 * out to the relay. With no service there is no Fly proxy to autostop it, so it
 * stays up until something stops it; `restart: always` brings it back if the
 * client exits.
 *
 * The enrollment code is only read on the first boot. Once the credential is on
 * the volume the client ignores it, so the same env serves every restart.
 */
const machineConfigFor = (
  host: ComputerHost,
  volumeId: string,
  appUrl: string,
  enrollCode: string
): FlyMachineConfig => ({
  env: {
    AGENTUM_ENROLL_CODE: enrollCode,
    AGENTUM_URL: appUrl,
  },
  guest: {
    cpu_kind: "shared",
    cpus: host.config.instance?.cpus ?? DEFAULT_CPUS,
    memory_mb: host.config.instance?.memory_mb ?? DEFAULT_MEMORY_MB,
  },
  image: host.config.image ?? DEFAULT_IMAGE,
  mounts: [{ path: COMPUTER_STATE_DIR, volume: volumeId }],
  restart: { policy: "always" },
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
  if (!env.PUBLIC_APP_URL) {
    throw new Error(
      "PUBLIC_APP_URL is not set, so the machine would not know where to connect."
    );
  }

  const volume = await gateway.createVolume(app, {
    name: volumeNameFor(agent.id),
    sizeGb: host.config.volume_gb ?? DEFAULT_VOLUME_GB,
    ...(host.config.region === undefined ? {} : { region: host.config.region }),
  });
  await setAgentComputerRef(db, agent.id, { volumeId: volume.id });

  // Minted after the volume, so a failed volume leaves no code behind. 24 h,
  // not 15 min: the machine redeems it whenever it first boots.
  const enrollCode = await issueEnrollmentCode(
    db,
    host,
    FLY_ENROLLMENT_CODE_TTL_MS
  );
  const machine = await gateway.createMachine(app, {
    config: machineConfigFor(host, volume.id, env.PUBLIC_APP_URL, enrollCode),
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
