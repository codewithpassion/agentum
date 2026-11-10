import { isAnthropicModel } from "@repo/services/cloud/models";
import type { MachineRecord } from "#/integrations/trpc/types";

export type MoveTarget = "cloud" | "machine" | "managed";

export const MOVE_TARGETS: readonly { id: MoveTarget; title: string }[] = [
  { id: "cloud", title: "Cloudflare" },
  { id: "managed", title: "Anthropic cloud" },
  { id: "machine", title: "Our machine" },
];

/** What a move costs, shown before the person confirms. */
export const MOVE_COST =
  "Open conversations start fresh, because the new runtime does not have their context. Files in the agent's sandbox do not move.";

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
