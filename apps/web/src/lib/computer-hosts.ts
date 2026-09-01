import type { ComputerHost, ComputerHostKind } from "./api";
import { formatRelativeTime } from "./format";

/**
 * The words and the commands the computer-host screens are made of, kept out of
 * the components so they can be tested without a DOM (docs/plan-computer-backends.md,
 * "UI").
 */

/** The published image; the same one Fly machines run. */
export const COMPUTERD_IMAGE = "ghcr.io/codewithpassion/agentum-computerd";

export type ContainerEngine = "docker" | "podman";

/**
 * The pairing command, verbatim from `apps/computerd/README.md`: a named volume
 * so the files outlive the container, a memory and CPU cap because the agent
 * decides what runs in there, and - under rootless Podman - `--userns=keep-id`
 * so the volume stays readable from the host.
 */
export const computerdRunCommand = (
  engine: ContainerEngine,
  input: { token: string; url: string }
): string =>
  [
    `${engine} run -d --name agentum-computer`,
    "--restart unless-stopped",
    "--memory 2g --cpus 2",
    ...(engine === "podman" ? ["--userns=keep-id"] : []),
    "-v agentum-computer:/home/agent",
    `-e AGENTUM_URL=${input.url}`,
    `-e AGENTUM_COMPUTER_TOKEN=${input.token}`,
    COMPUTERD_IMAGE,
  ].join(" \\\n  ");

export const COMPUTER_HOST_KIND_LABELS: Record<ComputerHostKind, string> = {
  fly: "Fly.io",
  self_hosted: "Self-hosted",
};

/** A host nothing has ever talked to has no last-seen time, only a promise. */
export const lastSeenLabel = (
  lastSeenAt: string | null,
  now = Date.now()
): string =>
  lastSeenAt === null
    ? "never seen"
    : formatRelativeTime(new Date(lastSeenAt).getTime(), now);

/**
 * A self-hosted host is one container, and a container is one agent's computer
 * (plan §3), so a host that already has an agent cannot take another. A Fly
 * host is an app, and every agent on it gets its own machine, so it never fills
 * up.
 */
export const hostInUseReason = (host: ComputerHost): string | null =>
  host.kind === "self_hosted" && host.agentIds.length > 0 ? "in use" : null;

/** Why this host cannot be removed yet, in words the owner can act on. */
export const hostRemovalBlock = (host: ComputerHost): string | null => {
  const count = host.agentIds.length;
  if (count === 0) {
    return null;
  }
  return `This host still runs ${count} agent${count === 1 ? "" : "s"}. Delete ${count === 1 ? "it" : "them"} first.`;
};

export interface HostChoice {
  /** Null when the host can be picked; otherwise why it cannot. */
  disabledReason: string | null;
  host: ComputerHost;
}

/** The hosts a new agent on `kind` may sit on, and which are already taken. */
export const hostChoicesFor = (
  hosts: ComputerHost[],
  kind: ComputerHostKind
): HostChoice[] =>
  hosts
    .filter((host) => host.kind === kind)
    .map((host) => ({ disabledReason: hostInUseReason(host), host }));

/**
 * Where an agent's computer runs, for the agent screen's header. The host name
 * is the useful half, so it leads for a self-hosted box; on Fly the app matters
 * too, and the host is named after it.
 */
export const computerSummary = (
  computer: ComputerHost["kind"] | "cloudflare",
  hostName: string | null
): string => {
  if (computer === "cloudflare") {
    return "Cloudflare";
  }
  if (computer === "fly") {
    return hostName ? `Fly · ${hostName}` : "Fly";
  }
  return hostName ? `${hostName} (self-hosted)` : "self-hosted";
};
