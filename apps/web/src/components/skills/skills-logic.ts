// Labels shared by the Skills page, a skill's page and the agent Skills tab.
import type { SkillVersion } from "#/integrations/trpc/types";

/** Agent ids to agent names, from `agents.list`. */
export type AgentNames = ReadonlyMap<string, string>;

/** Skill names are unique per owner, so every place that shows a name shows the owner too. */
export const ownerLabel = (
  ownerAgentId: string | null,
  agentNames: AgentNames
): string => {
  if (ownerAgentId === null) {
    return "People";
  }
  return agentNames.get(ownerAgentId) ?? "Unknown agent";
};

const RUN_ID_TAIL = 8;

export const authorLabel = (
  author: SkillVersion["author"],
  agentNames: AgentNames
): string => {
  if (author.kind === "system") {
    return "Library migration";
  }
  if (author.kind === "user") {
    return "A person";
  }
  const name = agentNames.get(author.id) ?? "Unknown agent";
  return author.runId === null
    ? name
    : `${name}, run ${author.runId.slice(-RUN_ID_TAIL)}`;
};

export const statusLabel = (status: SkillVersion["status"]): string => {
  if (status === "proposed") {
    return "Pending review";
  }
  return status === "approved" ? "Approved" : "Rejected";
};

/** "v3", or "v3 (pinned)" for a pinned assignment. */
export const versionLabel = (version: number, pinned = false): string =>
  pinned ? `v${version} (pinned)` : `v${version}`;

const REVOKE_DELAY_MS = 10_000;
const SKILL_ARCHIVE_TYPE = "application/octet-stream";

/** Starts a browser download of a base64 encoded file. */
export const saveBase64File = (filename: string, base64: string): void => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const url = URL.createObjectURL(
    new Blob([bytes], { type: SKILL_ARCHIVE_TYPE })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
};
