import type { MachineRole } from "@repo/db/shared";
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
 * Whether a machine's daemon is older than the newest published one. Only a
 * live machine with the agent_host role that has reported a version, against a
 * release that exists. Any different version counts: builds are ordered by
 * when they were published, not by their number.
 */
export const isDaemonOutdated = (
  machine: Pick<MachineRecord, "daemonVersion" | "roles" | "status">,
  latestVersion: string | null
): boolean =>
  latestVersion !== null &&
  machine.status !== "revoked" &&
  machine.roles.includes("agent_host") &&
  machine.daemonVersion !== null &&
  machine.daemonVersion !== latestVersion;

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
