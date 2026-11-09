import type { MachineRole } from "@repo/db/shared";
import type { Product } from "@repo/protocol/releases";
import type { MachineRecord } from "#/integrations/trpc/types";

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

/**
 * Whether a machine has a different version from its latest release. Includes
 * computer-only Rust clients, identified by their computer hello version.
 * Any different version counts: builds are ordered by
 * when they were published, not by their number.
 */
export const daemonProduct = (
  machine: Pick<MachineRecord, "capabilities"> &
    Partial<Pick<MachineRecord, "computerCapabilities">>
): Product =>
  (typeof machine.capabilities.agentSdk === "string" &&
    machine.capabilities.agentSdk.startsWith("claude-cli@")) ||
  (typeof machine.computerCapabilities?.clientVersion === "string" &&
    machine.computerCapabilities.clientVersion.startsWith("agentum-rs@"))
    ? "agentum-rs"
    : "agentum";

export const isDaemonOutdated = (
  machine: Pick<MachineRecord, "daemonVersion" | "roles" | "status"> &
    Partial<Pick<MachineRecord, "capabilities" | "computerCapabilities">>,
  latestVersion: string | null,
  latestRustVersion: string | null = null
): boolean => {
  const rust =
    daemonProduct({ ...machine, capabilities: machine.capabilities ?? {} }) ===
    "agentum-rs";
  const latest = rust ? latestRustVersion : latestVersion;
  const computerVersion = machine.computerCapabilities?.clientVersion;
  let version = machine.daemonVersion;
  if (!machine.roles.includes("agent_host")) {
    version =
      rust && typeof computerVersion === "string"
        ? computerVersion.slice("agentum-rs@".length)
        : null;
  }
  return (
    latest !== null &&
    machine.status !== "revoked" &&
    version !== null &&
    version !== latest
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
    return error instanceof Error ? error.message : "Something went wrong.";
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
