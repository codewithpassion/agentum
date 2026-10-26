// Safe to import from browser code: no driver, no Node APIs. Everything the UI
// needs from this package lives here; the other entries pull in drizzle. The
// schema takes its enum values from here too, so the UI and the tables agree.

export const IDENTITY_PROVIDERS = ["slack"] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

export const SLACK_APP_STATUSES = ["created", "installed", "revoked"] as const;
export type SlackAppStatus = (typeof SLACK_APP_STATUSES)[number];

/** Which channel messages an app answers: only mentions, or every message in a channel it is in. */
export const SLACK_LISTEN_MODES = ["mentions", "all"] as const;
export type SlackListenMode = (typeof SLACK_LISTEN_MODES)[number];

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
  // At least one open request. The runtime keeps the lease going.
  "waiting",
  "done",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** `desk` is the external desk API (`/api/desk/*`) and nothing else: `/mcp` refuses it. */
export const API_KEY_ACCESS = ["read", "write", "desk"] as const;
export type ApiKeyAccess = (typeof API_KEY_ACCESS)[number];

/** What a connected app may be given: a desk key is a key, never an OAuth client. */
export const OAUTH_CLIENT_ACCESS = ["read", "write"] as const;
export type OAuthClientAccess = (typeof OAUTH_CLIENT_ACCESS)[number];

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
  "run.limit_reached",
  "run.repeat_stopped",
  "run.waiting",
  "run.resumed",
  "request.opened",
  "request.answered",
  "request.expired",
  "request.cancelled",
  "tool_rule.changed",
  "message.user",
  "message.assistant",
  "message.reasoning",
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
  "slack.batch_started",
  "slack.listen_mode_changed",
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
  "network.request",
  "script.run",
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

/** Seconds a connector tool call may take before it is stopped. */
export const CONNECTOR_CALL_TIMEOUT_SECONDS = {
  default: 60,
  max: 300,
  min: 10,
} as const;

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

export const REQUEST_KINDS = ["approval", "question"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const REQUEST_STATUSES = [
  "pending",
  "answered",
  "expired",
  "cancelled",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const APPROVAL_DECISIONS = [
  "allow_once",
  "always_allow",
  "deny",
] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** `ask` stops a tool call for a person's decision. No rule means `allow`. */
export const TOOL_RULE_MODES = ["ask", "allow"] as const;
export type ToolRuleMode = (typeof TOOL_RULE_MODES)[number];

export const ANSWER_SURFACES = ["web", "slack"] as const;
export type AnswerSurface = (typeof ANSWER_SURFACES)[number];

/** How long an approval stays open: one hour. */
export const APPROVAL_TTL_MS = 60 * 60_000;

/** How long a question stays open: one day. */
export const QUESTION_TTL_MS = 24 * 60 * 60_000;

/** Most questions in one ask-user request. */
export const QUESTIONS_MAX = 4;

/** Most choices on one question. */
export const CHOICES_MAX = 6;

/** The kinds of line in a task's action log. */
export const ACTION_LOG_KINDS = [
  "thought",
  "tool_call",
  "tool_result",
  "note",
  "error",
] as const;
export type ActionLogKind = (typeof ACTION_LOG_KINDS)[number];

/** The three lanes of the desk, left to right. */
export const DESK_LANES = ["needs_you", "running", "done"] as const;
export type DeskLane = (typeof DESK_LANES)[number];

/** What a Needs you card asks of a person. Later milestones append theirs. */
export const NEEDS_YOU_KINDS = [
  "approval",
  "question",
  "skill_proposal",
  "trigger_proposal",
  "routine_proposal",
  "inbox_reply",
] as const;
export type NeedsYouKind = (typeof NEEDS_YOU_KINDS)[number];

/** The colour of a status band. */
export const BAND_TONES = ["ok", "waiting", "running", "error"] as const;
export type BandTone = (typeof BAND_TONES)[number];

/** One key and value shown as a chip on a receipt step. */
export interface KeyChip {
  key: string;
  value: string;
}

export const RECEIPT_STEP_KINDS = [
  "trigger",
  "message",
  "tool",
  "skill",
  "approval",
  "question",
  "result",
  "error",
] as const;
export type ReceiptStepKind = (typeof RECEIPT_STEP_KINDS)[number];

export const RECEIPT_STEP_STATES = [
  "done",
  "running",
  "paused",
  "failed",
] as const;
export type ReceiptStepState = (typeof RECEIPT_STEP_STATES)[number];

/** One step of a task's receipt: what went in, what came out, and what it links to. */
export interface ReceiptStep {
  /** How many of the next kind of thing this step handed on, or null for the last step. */
  countToNext: { n: number; noun: string } | null;
  detail: string;
  /** The events the step was built from. */
  eventIds: string[];
  in: KeyChip[];
  index: number;
  kind: ReceiptStepKind;
  out: KeyChip[];
  /** The V1 request this approval or question links to, when available. */
  requestId?: string;
  state: ReceiptStepState;
  title: string;
}

/** One line of a task's action log. */
export interface ActionLogEntry {
  at: string;
  eventId: string;
  kind: ActionLogKind;
  text: string;
}

/** The one sentence under a desk card or a task title, with the colour it takes. */
export interface StatusBand {
  text: string;
  tone: BandTone;
}

export const DESK_CARD_KINDS = [
  "run",
  "thread",
  "request",
  "proposal",
] as const;
export type DeskCardKind = (typeof DESK_CARD_KINDS)[number];

/** One card on the desk. */
export interface DeskCard {
  agentId: string;
  at: string;
  band: StatusBand;
  id: string;
  kind: DeskCardKind;
  lane: DeskLane;
  needsYouKind?: NeedsYouKind;
  runId?: string;
  startedBy: string;
  threadId?: string;
  title: string;
}
