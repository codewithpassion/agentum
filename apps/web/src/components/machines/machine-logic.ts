import type { MachineRole } from "@repo/db/shared";
import type { MachineRecord } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";

/** The two roles of a machine, in the words people see. */
export const ROLE_LABELS: Record<MachineRole, string> = {
  agent_host: "Runs the agent",
  computer: "Computer",
};

export type RoleTone = "good" | "muted" | "bad";

export interface RoleRow {
  label: string;
  role: MachineRole;
  /** "Online", "Offline" or "Revoked". A revoked machine is revoked for both roles. */
  status: string;
  tone: RoleTone;
}

type RoleMachine = Pick<MachineRecord, "computerStatus" | "roles" | "status">;

const roleStatus = (
  machine: RoleMachine,
  role: MachineRole
): { status: string; tone: RoleTone } => {
  if (machine.status === "revoked") {
    return { status: "Revoked", tone: "bad" };
  }
  const online =
    role === "computer"
      ? machine.computerStatus === "online"
      : machine.status === "online";
  return online
    ? { status: "Online", tone: "good" }
    : { status: "Offline", tone: "muted" };
};

/** One row per role the machine has, each with its own status. */
export const roleRows = (machine: RoleMachine): RoleRow[] =>
  machine.roles.map((role) => ({
    label: ROLE_LABELS[role],
    role,
    ...roleStatus(machine, role),
  }));

/** A computer is "Desktop" or "Headless". Null until its client first said hello. */
export const computerKind = (
  machine: Pick<MachineRecord, "computerCapabilities">
): "Desktop" | "Headless" | null => {
  const { computerCapabilities } = machine;
  if (computerCapabilities === null) {
    return null;
  }
  return computerCapabilities.desktop === true ? "Desktop" : "Headless";
};

/** Only a machine that runs the agent and has no computer yet can take the computer role. */
export const canAddComputerRole = (
  machine: Pick<MachineRecord, "roles" | "status">
): boolean =>
  machine.status !== "revoked" &&
  machine.roles.includes("agent_host") &&
  !machine.roles.includes("computer");

/** The prefix of the version string a Rust client reports in its computer hello. */
const RUST_VERSION_PREFIX = "agentum-rs@";

/**
 * Whether a machine runs the Rust client. A machine that last connected with
 * the retired TypeScript daemon or Go computer client does not, and cannot be
 * updated in place.
 */
export const isRustMachine = (
  machine: Pick<MachineRecord, "capabilities"> &
    Partial<Pick<MachineRecord, "computerCapabilities">>
): boolean =>
  (typeof machine.capabilities.agentSdk === "string" &&
    machine.capabilities.agentSdk.startsWith("claude-cli@")) ||
  (typeof machine.computerCapabilities?.clientVersion === "string" &&
    machine.computerCapabilities.clientVersion.startsWith(RUST_VERSION_PREFIX));

/**
 * Whether a Rust machine has a different version from the latest release.
 * Includes computer-only clients, identified by their computer hello version.
 * Any different version counts: builds are ordered by when they were
 * published, not by their number.
 */
export const isDaemonOutdated = (
  machine: Pick<MachineRecord, "daemonVersion" | "roles" | "status"> &
    Partial<Pick<MachineRecord, "capabilities" | "computerCapabilities">>,
  latestVersion: string | null
): boolean => {
  if (
    !isRustMachine({ ...machine, capabilities: machine.capabilities ?? {} })
  ) {
    return false;
  }
  const computerVersion = machine.computerCapabilities?.clientVersion;
  let version = machine.daemonVersion;
  if (!machine.roles.includes("agent_host")) {
    version =
      typeof computerVersion === "string"
        ? computerVersion.slice(RUST_VERSION_PREFIX.length)
        : null;
  }
  return (
    latestVersion !== null &&
    machine.status !== "revoked" &&
    version !== null &&
    version !== latestVersion
  );
};

/** The machines an agent can drive: a computer role, not revoked. */
export const computersOf = <T extends Pick<MachineRecord, "roles" | "status">>(
  machines: T[]
): T[] =>
  machines.filter(
    (machine) =>
      machine.status !== "revoked" && machine.roles.includes("computer")
  );

/** A machine that is not revoked can be revoked. Revoking is permanent. */
export const canRevoke = (machine: Pick<MachineRecord, "status">): boolean =>
  machine.status !== "revoked";

/** Revokes one machine. Resolves to null on success, or the error text to show. */
export const revokeMachine = async (
  revoke: (input: { machineId: string }) => Promise<unknown>,
  machineId: string
): Promise<string | null> => {
  try {
    await revoke({ machineId });
    return null;
  } catch (error) {
    return errorMessage(error);
  }
};

/** The one name for enrolling a machine, on the page and in Find. */
export const ENROLL_BUTTON_LABEL = "Enrol a machine";

/** Revoked machines show only when the toggle is on. */
export const visibleMachines = <T extends Pick<MachineRecord, "status">>(
  machines: T[],
  showRevoked: boolean
): T[] =>
  showRevoked
    ? machines
    : machines.filter((machine) => machine.status !== "revoked");

/**
 * The first machine whose id was not known when the dialog opened and that has
 * connected. Redeeming a code makes the row offline, so only an online role counts.
 */
export const newMachine = <
  T extends Pick<MachineRecord, "computerStatus" | "id" | "status">,
>(
  machines: T[],
  knownIds: readonly string[]
): T | null =>
  machines.find(
    (machine) =>
      !knownIds.includes(machine.id) &&
      (machine.status === "online" || machine.computerStatus === "online")
  ) ?? null;
