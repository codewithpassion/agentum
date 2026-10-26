import type { AgentRuntime } from "@repo/db/shared";
import { describeCron } from "#/components/routines/describe-cron.ts";
import type { AgentProfileView } from "#/integrations/trpc/types";

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

export const LIBRARY_NOTE = "Access per folder comes later.";

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

export const channelChips = (
  channels: Channels,
  emailLocal: string | null
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
  const email: Chip =
    emailLocal === null
      ? { key: "email", label: "Email · no address yet", tone: "default" }
      : { key: "email", label: "Email", tone: "on" };
  const whatsapp: Chip = {
    key: "whatsapp",
    label: "WhatsApp (later)",
    tone: "default",
  };
  return [slack, email, whatsapp];
};

export const folderLabel = (folder: {
  home: boolean;
  access: "read_write";
}): string => (folder.home ? "home · read and write" : "read and write");

export const addressText = (
  emailLocal: string | null,
  domain: string
): string | null => (emailLocal === null ? null : `${emailLocal}@${domain}`);
