// Safe to import from browser code: no driver, no Node APIs. Everything the UI
// needs from this package lives here; the other entries pull in drizzle. The
// schema takes its enum values from here too, so the UI and the tables agree.

export const IDENTITY_PROVIDERS = ["slack"] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

export const SLACK_APP_STATUSES = ["created", "installed", "revoked"] as const;
export type SlackAppStatus = (typeof SLACK_APP_STATUSES)[number];

export const AGENT_RUNTIMES = ["machine", "managed", "cloud", "fake"] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

export const AGENT_STATUSES = ["active", "archived"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const MACHINE_STATUSES = ["online", "offline", "revoked"] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

export const RUN_STATUSES = [
  "queued",
  "offered",
  "running",
  "done",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const API_KEY_ACCESS = ["read", "write"] as const;
export type ApiKeyAccess = (typeof API_KEY_ACCESS)[number];

/** Most files one run can take as input. The composer and `startRun` both enforce it. */
export const INPUT_FILES_MAX = 20;

/** Largest file the upload route and the files service accept: 50 MB. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export const TRIGGER_KINDS = ["http", "routine"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** A proposal from an agent's run that no person has approved yet. */
export const isPendingProposal = (row: {
  approvedAt: string | null;
  proposedByAgentId: string | null;
}): boolean => row.proposedByAgentId !== null && row.approvedAt === null;

/** Errors in a row that switch a routine off. */
export const ROUTINE_ERROR_LIMIT = 5;

/** Most bytes in one library file: 10 MB. */
export const LIBRARY_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Most bytes in one workspace's library: 1 GB. */
export const LIBRARY_MAX_BYTES = 1024 * 1024 * 1024;

export const LIBRARY_ENTRY_KINDS = ["file", "dir"] as const;
export type LibraryEntryKind = (typeof LIBRARY_ENTRY_KINDS)[number];

export const FILE_SOURCES = ["upload", "slack", "run", "library"] as const;
export type FileSource = (typeof FILE_SOURCES)[number];

export const EVENT_TYPES = [
  "run.queued",
  "run.started",
  "run.cancelled",
  "run.finished",
  "run.failed",
  "run.interrupted",
  "message.user",
  "message.assistant",
  "tool.call",
  "tool.result",
  "connector.call",
  "connector.needs_auth",
  "connector.timeout",
  "trigger.fired",
  "trigger.created",
  "trigger.approved",
  "trigger.rejected",
  "trigger.deleted",
  "slack.received",
  "slack.named",
  "slack.unlinked_sender",
  "slack.event_refused",
  "slack.delivered",
  "slack.message_sent",
  "slack.app_installed",
  "slack.app_revoked",
  "inbox.posted",
  "inbox.loop_stopped",
  "machine.online",
  "machine.offline",
  "agent.created",
  "agent.updated",
  "credential.created",
  "credential.revoked",
  "api_key.created",
  "library.write",
  "library.delete",
  "library.command",
  "library.conflict",
  "secret.delivered",
  "secret.injected",
  "skill.created",
  "skill.committed",
  "skill.approved",
  "skill.rejected",
  "skill.reverted",
  "skill.assigned",
  "skill.unassigned",
  "skill.pinned",
  "skill.imported",
  "workspace.snapshot",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_ACTOR_KINDS = [
  "user",
  "agent",
  "trigger",
  "system",
] as const;
export type EventActorKind = (typeof EVENT_ACTOR_KINDS)[number];

/** How a workspace secret reaches an agent: added to its outgoing requests, or set as an environment variable. */
export const SECRET_MODES = ["env", "proxy"] as const;
export type SecretMode = (typeof SECRET_MODES)[number];

/** Model providers a workspace can bring its own key for. */
export const MODEL_PROVIDERS = ["openrouter"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const CONNECTOR_AUTH_KINDS = ["none", "header", "oauth"] as const;
export type ConnectorAuthKind = (typeof CONNECTOR_AUTH_KINDS)[number];

export const CONNECTOR_STATUSES = ["ok", "needs_auth"] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

export const CREDENTIAL_OWNER_KINDS = ["user", "agent"] as const;
export type CredentialOwnerKind = (typeof CREDENTIAL_OWNER_KINDS)[number];

export const CREDENTIAL_STATUSES = ["ok", "needs_auth", "revoked"] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export const CREDENTIAL_MODES = ["user_or_agent", "agent", "user"] as const;
export type CredentialMode = (typeof CREDENTIAL_MODES)[number];

/** How the token endpoint wants the client to identify itself (RFC 6749 section 2.3). */
export const TOKEN_ENDPOINT_AUTH_METHODS = [
  "none",
  "client_secret_basic",
  "client_secret_post",
] as const;
export type TokenEndpointAuthMethod =
  (typeof TOKEN_ENDPOINT_AUTH_METHODS)[number];

export const INBOX_AUTHOR_KINDS = ["user", "agent"] as const;
export type InboxAuthorKind = (typeof INBOX_AUTHOR_KINDS)[number];

/** Who wrote a skill version: a person, an agent's run, or the one-off library migration. */
export const SKILL_AUTHOR_KINDS = ["user", "agent", "system"] as const;
export type SkillAuthorKind = (typeof SKILL_AUTHOR_KINDS)[number];

/** A person's version is `approved` at once, an agent's starts `proposed` and a person decides. */
export const SKILL_VERSION_STATUSES = [
  "approved",
  "proposed",
  "rejected",
] as const;
export type SkillVersionStatus = (typeof SKILL_VERSION_STATUSES)[number];
