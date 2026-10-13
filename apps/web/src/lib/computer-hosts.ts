import type { ComputerHost, ComputerHostKind } from "./api";
import { formatRelativeTime } from "./format";

/**
 * The words and the commands the computer-host screens are made of, kept out of
 * the components so they can be tested without a DOM (docs/plan-computer-backends.md,
 * "UI").
 */

/** The published images; the base one is also what Fly machines run. */
export const COMPUTER_IMAGE = "ghcr.io/codewithpassion/agentum-computer:latest";
export const COMPUTER_DESKTOP_IMAGE =
  "ghcr.io/codewithpassion/agentum-computer-desktop:latest";

/** Where to download the profile the desktop command points `--security-opt` at. */
export const SECCOMP_PROFILE_URL =
  "https://raw.githubusercontent.com/codewithpassion/agentum/main/apps/computer/packaging/desktop/seccomp.json";

export type ComputerImageVariant = "base" | "desktop";

const MAX_HOST_SLUG_LENGTH = 40;
const NON_SLUG_RUNS = /[^a-z0-9]+/g;
const EDGE_HYPHENS = /^-+|-+$/g;

const toSlug = (text: string): string =>
  text.toLowerCase().replace(NON_SLUG_RUNS, "-").replace(EDGE_HYPHENS, "");

/**
 * The host's name as a Docker-safe slug. A name with nothing usable in it falls
 * back to the start of the host id, so every host still gets its own name.
 */
export const computerHostSlug = (
  host: Pick<ComputerHost, "id" | "name">
): string =>
  toSlug(toSlug(host.name).slice(0, MAX_HOST_SLUG_LENGTH)) ||
  toSlug(host.id.slice(0, 8));

/**
 * The container, volume and hostname a host's command uses. Each host gets its
 * own, so several can run on one machine.
 */
const computerResourceName = (
  variant: ComputerImageVariant,
  host: Pick<ComputerHost, "id" | "name">
): string => `agentum-${variant}-${computerHostSlug(host)}`;

/**
 * The enrol-and-run command, mirroring `apps/computer/README.md`: the client
 * enrols itself from the environment on first start, and a named volume on its
 * state dir keeps the credential across restarts, so the spent code left in
 * the command is harmless. The desktop image needs the committed seccomp
 * profile because Chromium's sandbox wants user namespaces, which Docker's
 * default profile refuses.
 */
export const computerRunCommand = (
  variant: ComputerImageVariant,
  input: { code: string; host: Pick<ComputerHost, "id" | "name">; url: string }
): string => {
  const name = computerResourceName(variant, input.host);
  return [
    `docker run -d --restart unless-stopped --name ${name} --hostname ${name}`,
    ...(variant === "desktop" ? ["--security-opt seccomp=./seccomp.json"] : []),
    `-e AGENTUM_URL=${input.url}`,
    `-e AGENTUM_ENROLL_CODE=${input.code}`,
    `-v ${name}:/var/lib/agentum-computer`,
    variant === "desktop" ? COMPUTER_DESKTOP_IMAGE : COMPUTER_IMAGE,
  ].join(" \\\n  ");
};

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
