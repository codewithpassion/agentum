import type {
  AgentRuntime,
  MachineStatus,
  MailboxStatus,
} from "@repo/db/shared";
import {
  computerKind,
  computersOf,
  roleRows,
} from "#/components/machines/machine-logic.ts";
import { describeCron } from "#/components/routines/describe-cron.ts";
import type {
  AgentProfileView,
  MachineRecord,
} from "#/integrations/trpc/types";

export interface Chip {
  key: string;
  label: string;
  tone: "default" | "warn" | "on";
}

type Header = AgentProfileView["header"];
type Tools = AgentProfileView["tools"];
type Skills = AgentProfileView["skills"];
type Starts = AgentProfileView["startsOn"];
type Channels = AgentProfileView["channels"];
type AgentRefs = AgentProfileView["handsTo"];

export const LIBRARY_NOTE =
  "On a machine or VM these folders sync live. Each task writes to its task folder.";

export const runtimeWords = (
  runtime: AgentRuntime,
  machine: { name: string } | null
): string => {
  switch (runtime) {
    case "machine":
      return machine ? `Runs on ${machine.name}` : "Runs on a machine";
    case "cloud":
      return "Runs on Cloudflare";
    case "managed":
      return "Runs on Anthropic cloud";
    default:
      return "Runs on a test runner";
  }
};

export interface RuntimeOption {
  /** True for the runtime the agent has now. */
  current: boolean;
  /** "Online" or "Offline" on the current machine runtime, otherwise null. */
  machineState: string | null;
  runtime: "managed" | "cloud" | "machine";
  /** The plain-words description. */
  text: string;
  /** "Anthropic cloud", or "Our machine: laptop" when the agent runs on that machine. */
  title: string;
}

const MACHINE_STATE_WORDS: Record<MachineStatus, string> = {
  offline: "Offline",
  online: "Online",
  revoked: "Revoked",
};

/** The three runtimes in plain words, the agent's current one marked. */
export const runtimeOptions = (
  runtime: AgentRuntime,
  machine: { name: string; status: MachineStatus } | null
): RuntimeOption[] => {
  const onMachine = runtime === "machine";
  return [
    {
      current: runtime === "managed",
      machineState: null,
      runtime: "managed",
      text: "Managed Agents. Simplest. Has its own sandbox.",
      title: "Anthropic cloud",
    },
    {
      current: runtime === "cloud",
      machineState: null,
      runtime: "cloud",
      text: "Always on, lowest cost for many small jobs.",
      title: "Cloudflare",
    },
    {
      current: onMachine,
      machineState:
        onMachine && machine ? MACHINE_STATE_WORDS[machine.status] : null,
      runtime: "machine",
      text: "Claude Code on that machine. Sees local files.",
      title:
        onMachine && machine ? `Our machine: ${machine.name}` : "Our machine",
    },
  ];
};

export const statusText = (
  header: Header
): { label: string; runId: string | null } | null => {
  if (header.waitingRun) {
    const { runId } = header.waitingRun;
    return { label: `Paused on task #${runId.slice(-4)}`, runId };
  }
  if (header.status === "archived") {
    return { label: "Archived", runId: null };
  }
  if (header.status === "draft") {
    return { label: "Draft", runId: null };
  }
  return null;
};

export const toolChips = (tools: Tools): Chip[] => {
  const connectors = tools.connectors.map(
    (connector): Chip => ({
      key: `connector:${connector.connectorId}`,
      label:
        connector.allowedTools === null
          ? connector.name
          : `${connector.name} · ${connector.allowedTools.length} of ${connector.toolCount} tools`,
      tone: connector.status === "active" ? "default" : "warn",
    })
  );
  const secrets = tools.secrets.map(
    (secret): Chip => ({
      key: `secret:${secret.id}`,
      label: `${secret.name} · hidden`,
      tone: "default",
    })
  );
  return [...connectors, ...secrets];
};

export const skillChips = (skills: Skills): Chip[] =>
  skills.flatMap((skill): Chip[] => {
    const base: Chip = {
      key: `skill:${skill.skillId}`,
      label:
        skill.pinnedVersion === null
          ? skill.name
          : `${skill.name} v${skill.pinnedVersion}`,
      tone: "default",
    };
    if (skill.proposedVersion === null) {
      return [base];
    }
    return [
      base,
      {
        key: `skill:${skill.skillId}:proposed`,
        label: `${skill.name} v${skill.proposedVersion} proposed`,
        tone: "warn",
      },
    ];
  });

export const handsToChips = (handsTo: AgentRefs): Chip[] =>
  handsTo.map((agent) => ({
    key: `agent:${agent.id}`,
    label: agent.name,
    tone: "default",
  }));

export const receivesFromText = (receivesFrom: AgentRefs): string | null =>
  receivesFrom.length === 0
    ? null
    : `Receives from ${receivesFrom.map((agent) => agent.name).join(", ")}`;

export const startChips = (startsOn: Starts): Chip[] => {
  const triggers = startsOn.triggers.map(
    (trigger): Chip => ({
      key: `trigger:${trigger.id}`,
      label: trigger.paused ? `${trigger.name} · paused` : trigger.name,
      tone: "default",
    })
  );
  const routines = startsOn.routines.map((routine): Chip => {
    const label = describeCron(routine.cron, routine.timezone);
    return {
      key: `routine:${routine.id}`,
      label: routine.paused ? `${label} · paused` : label,
      tone: "default",
    };
  });
  const slack: Chip[] =
    startsOn.slackMention === null
      ? []
      : [{ key: "slack", label: "Slack mention", tone: "default" }];
  return [...triggers, ...routines, ...slack];
};

const emailChip = (
  emailLocal: string | null,
  mailStatus: MailboxStatus | null
): Chip => {
  if (emailLocal === null) {
    return { key: "email", label: "Email · no address yet", tone: "default" };
  }
  switch (mailStatus) {
    case "active":
      return { key: "email", label: "Email", tone: "on" };
    case "provisioning":
      return { key: "email", label: "Email · setting up", tone: "default" };
    case "failed":
      return { key: "email", label: "Email · failed", tone: "warn" };
    case "disabled":
      return { key: "email", label: "Email · off", tone: "default" };
    default:
      return { key: "email", label: "Email · reserved", tone: "default" };
  }
};

export const channelChips = (
  channels: Channels,
  emailLocal: string | null,
  mailStatus: MailboxStatus | null
): Chip[] => {
  const app = channels.slack;
  let slack: Chip;
  if (app === null) {
    slack = { key: "slack", label: "Slack · not set up", tone: "default" };
  } else if (app.status === "created") {
    slack = {
      key: "slack",
      label: "Slack app · not installed",
      tone: "default",
    };
  } else if (app.status === "installed") {
    slack = { key: "slack", label: "Slack app", tone: "on" };
  } else {
    slack = { key: "slack", label: "Slack app · revoked", tone: "warn" };
  }
  const email = emailChip(emailLocal, mailStatus);
  const whatsapp: Chip = {
    key: "whatsapp",
    label: "WhatsApp (later)",
    tone: "default",
  };
  return [slack, email, whatsapp];
};

export const folderLabel = (folder: {
  home: boolean;
  access: "read" | "write";
}): string => {
  if (folder.home) {
    return "home · read and write";
  }
  return folder.access === "read" ? "read only" : "read and write";
};

export const WIKI_LABEL = "read · suggestions";

export const addressText = (
  emailLocal: string | null,
  domain: string
): string | null => (emailLocal === null ? null : `${emailLocal}@${domain}`);

/** The Computer card's line about the machine the agent runs on. */
export const machineAgentWords = (machine: { name: string } | null): string =>
  machine
    ? `This agent runs on ${machine.name}.`
    : "This agent runs on a machine.";

export interface ComputerChoice {
  /** True for the computer the agent has now. */
  attached: boolean;
  id: string;
  /** "Desktop", "Headless" or "Not connected yet". */
  kind: string;
  name: string;
  /** "Online", "Offline" or "Revoked" for the computer role. */
  status: string;
  tone: "good" | "muted" | "bad";
}

/**
 * The computers an agent can attach to, the attached one marked. A revoked
 * computer stays in the list while the agent holds it, so it can be detached.
 */
export const computerChoices = (
  attachedId: string | null,
  machines: MachineRecord[]
): ComputerChoice[] =>
  machines
    .filter((machine) =>
      machine.id === attachedId
        ? machine.roles.includes("computer")
        : computersOf([machine]).length > 0
    )
    .map((machine) => {
      const row = roleRows(machine).find((item) => item.role === "computer");
      return {
        attached: machine.id === attachedId,
        id: machine.id,
        kind: computerKind(machine) ?? "Not connected yet",
        name: machine.name,
        status: row?.status ?? "Offline",
        tone: row?.tone ?? "muted",
      };
    });
