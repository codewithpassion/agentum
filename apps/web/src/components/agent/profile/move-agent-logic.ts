import { isAnthropicModel } from "@repo/services/cloud/models";
import type { MachineRecord } from "#/integrations/trpc/types";
import { RUNTIME_NAMES } from "./profile-logic.ts";

export type MoveTarget = "cloud" | "machine" | "managed";

export const MOVE_TARGETS: readonly { id: MoveTarget; title: string }[] = [
  { id: "cloud", title: RUNTIME_NAMES.cloud },
  { id: "managed", title: RUNTIME_NAMES.managed },
  { id: "machine", title: RUNTIME_NAMES.machine },
];

/** What a move costs, shown before the person confirms. */
export const MOVE_COST =
  "Open conversations start fresh, because the agent will run somewhere that does not have their context. Files in the agent's sandbox do not move.";

/** Extra to say for one target. A Cloud conversation is stored by Cloudflare and a move does not erase it. */
export const moveNote = (target: MoveTarget): string | null => {
  switch (target) {
    case "cloud":
      return "A conversation that ran on Cloud before may pick up there, without what happened since.";
    case "machine":
      return "The agent's computer is detached.";
    default:
      return null;
  }
};

export interface MoveBlocker {
  /** How to clear it: a page to go to. */
  fix: {
    label: string;
    to: "/settings/machines" | "/settings/model-providers";
  };
  /** What stops the move. */
  text: string;
}

/** The machines that can host an agent: the daemon role, not revoked. */
export const hostMachines = (machines: readonly MachineRecord[]) =>
  machines.filter(
    (machine) =>
      machine.roles.includes("agent_host") && machine.status !== "revoked"
  );

/** The first thing that stops a move to `target`, or null when it can go ahead. */
export const moveBlocker = ({
  hasAnthropicKey,
  hosts,
  target,
}: {
  hasAnthropicKey: boolean;
  hosts: readonly MachineRecord[];
  target: MoveTarget;
}): MoveBlocker | null => {
  if (target === "managed" && !hasAnthropicKey) {
    return {
      fix: {
        label: "Add a key in Model providers",
        to: "/settings/model-providers",
      },
      text: "This workspace has no Anthropic API key, and Anthropic cloud needs one.",
    };
  }
  if (target === "machine" && hosts.length === 0) {
    return {
      fix: { label: "Enroll a machine", to: "/settings/machines" },
      text: "No machine can run an agent yet.",
    };
  }
  return null;
};

/** Anthropic cloud and a machine run Anthropic models only. */
export const needsAnthropicModel = (target: MoveTarget, model: string) =>
  target !== "cloud" && !isAnthropicModel(model);
