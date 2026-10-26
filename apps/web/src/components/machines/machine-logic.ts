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

/** The machines an agent can drive: a computer role, not revoked. */
export const computersOf = <T extends Pick<MachineRecord, "roles" | "status">>(
  machines: T[]
): T[] =>
  machines.filter(
    (machine) =>
      machine.status !== "revoked" && machine.roles.includes("computer")
  );
