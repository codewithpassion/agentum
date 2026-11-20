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

/** Which way a team room message crossed: `in` from Slack, `out` to Slack. */
export const SLACK_ROOM_DIRECTIONS = ["in", "out"] as const;
export type SlackRoomDirection = (typeof SLACK_ROOM_DIRECTIONS)[number];

export const AGENT_RUNTIMES = ["machine", "managed", "cloud", "fake"] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

export const AGENT_STATUSES = ["active", "archived", "draft"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** How an agent speaks. The builder offers one of these. */
export const VOICE_PRESETS = [
  "brief",
  "careful",
  "friendly",
  "formal",
] as const;
export type VoicePreset = (typeof VOICE_PRESETS)[number];

/** The starting points the builder offers. */
export const AGENT_TEMPLATE_IDS = [
  "inbox_triage",
  "meeting_follow_up",
  "lead_research",
  "invoice_filing",
  "weekly_report",
  "support_first_reply",
  "drive_tidy",
  "social_drafts",
] as const;
export type AgentTemplateId = (typeof AGENT_TEMPLATE_IDS)[number];

/** The parts of an agent's profile the builder fills in and asks about. */
export const PROFILE_FIELDS = [
  "does",
  "voice",
  "rules",
  "tools",
  "skills",
  "starts_on",
  "hands_to",
  "runs_on",
  "library",
  "address",
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** A profile field the builder cannot fill yet, and the question that would. */
export interface ProfileGap {
  field: ProfileField;
  question: string;
}

export const MACHINE_STATUSES = ["online", "offline", "revoked"] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

/**
 * The jobs one machine can hold. `agent_host` runs agents through the daemon.
 * `computer` is a client an agent drives (shell, files, desktop). One machine
 * can hold both roles, and a revoke ends both.
 */
export const MACHINE_ROLES = ["agent_host", "computer"] as const;
export type MachineRole = (typeof MACHINE_ROLES)[number];

/** The roles an enrol code grants; `both` is not a machine role. */
export const MACHINE_ENROLL_ROLES = [...MACHINE_ROLES, "both"] as const;
export type MachineEnrollRole = (typeof MACHINE_ENROLL_ROLES)[number];

/** Presence of a machine's computer role. `machines.computer_status` is null when the machine has none. */
export const COMPUTER_STATUSES = ["online", "offline"] as const;
export type ComputerStatus = (typeof COMPUTER_STATUSES)[number];

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

/** Runs in these states may still read the skills and connectors of their agent. */
export const LIVE_RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "offered",
  "running",
  "waiting",
];

/**
 * `LIVE_RUN_STATUSES` as SQL literals. The partial index `runs_live_status_idx`
 * is written with this text, and SQLite only uses a partial index for a query
 * whose own condition repeats it, so a query that wants the index writes the
 * same text, not bound parameters.
 */
export const LIVE_RUN_STATUS_LITERALS = LIVE_RUN_STATUSES.map(
  (status) => `'${status}'`
).join(", ");

/**
 * `desk` is the external desk API (`/api/desk/*`) and nothing else: `/mcp` refuses it.
 * `admin` is `write` plus the setup tools: secrets, machines, keys. Only a workspace admin mints one.
 */
export const API_KEY_ACCESS = ["read", "write", "desk", "admin"] as const;
export type ApiKeyAccess = (typeof API_KEY_ACCESS)[number];

/** What a connected app may be given: a desk key is a key, never an OAuth client. */
export const OAUTH_CLIENT_ACCESS = ["read", "write"] as const;
export type OAuthClientAccess = (typeof OAUTH_CLIENT_ACCESS)[number];

/** Most files one run can take as input. The composer and `startRun` both enforce it. */
export const INPUT_FILES_MAX = 20;

/** Largest file the upload route and the files service accept: 50 MB. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * `dream` is the system's, one per agent, made and removed from
 * `agents.remember.dreamSchedule` (DR.4 owns that). No person creates one by
 * hand: `triggers.create` makes `http` triggers only. The map and the jobs list
 * leave it out.
 */
export const TRIGGER_KINDS = [
  "http",
  "routine",
  "mail",
  "app",
  "dream",
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** A proposal from an agent's run that no person has approved yet. */
export const isPendingProposal = (row: {
  approvedAt: string | null;
  proposedByAgentId: string | null;
}): boolean => row.proposedByAgentId !== null && row.approvedAt === null;

/** Errors in a row that switch a routine off. */
export const ROUTINE_ERROR_LIMIT = 5;

/** Who is on the other end of an agent connection. */
export const A2A_PEER_KINDS = [
  "harbourmaster",
  "a2a_inbound",
  "a2a_outbound",
] as const;
export type A2aPeerKind = (typeof A2A_PEER_KINDS)[number];

export const A2A_CONNECTION_STATUSES = [
  "inviting",
  "awaiting_peer",
  "needs_approval",
  "activating",
  "active",
  "declined",
  "revoked",
] as const;
export type A2aConnectionStatus = (typeof A2A_CONNECTION_STATUSES)[number];

/** Whether a message from the peer is refused, waits for a person, or starts a run. */
export const A2A_INBOUND_POLICIES = ["off", "approve", "auto"] as const;
export type A2aInboundPolicy = (typeof A2A_INBOUND_POLICIES)[number];
export const A2A_DEFAULT_INBOUND_POLICY: A2aInboundPolicy = "approve";

/** In a run a connection started: every tool call asks a person, or the agent's own rules apply. */
export const A2A_TOOL_POLICIES = ["ask", "agent_rules"] as const;
export type A2aToolPolicy = (typeof A2A_TOOL_POLICIES)[number];
export const A2A_DEFAULT_TOOL_POLICY: A2aToolPolicy = "ask";

/** Whether our agent's message to the peer is refused, waits for a person, or sends. */
export const A2A_OUTBOUND_POLICIES = ["off", "approve", "auto"] as const;
export type A2aOutboundPolicy = (typeof A2A_OUTBOUND_POLICIES)[number];
export const A2A_DEFAULT_OUTBOUND_POLICY: A2aOutboundPolicy = "approve";

/** Per connection per hour: tasks both ways, the peer's answers and the wakes they start. */
export const A2A_DEFAULT_HOURLY_LIMIT = 20;

/**
 * A2A task states as stored in `a2a_tasks.state` and `a2a_outbound_tasks.state`.
 * The strings are the wire names, so `@repo/a2a` and this list must agree.
 */
export const A2A_TASK_STATES = [
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
] as const;
export type A2aTaskState = (typeof A2A_TASK_STATES)[number];
export const A2A_DEFAULT_TASK_STATE: A2aTaskState = "TASK_STATE_SUBMITTED";

/**
 * The tool name of the approval card an outbound A2A message waits behind
 * (`outbound_policy = approve`). Its tool use id is `a2a:<outboundTaskId>`.
 */
export const A2A_SEND_TOOL = "a2a_send";

/** What the `a2a_outbox` row delivers. */
export const A2A_OUTBOX_KINDS = [
  "push",
  "pair_activate",
  "pair_decline",
  "pair_revoke",
] as const;
export type A2aOutboxKind = (typeof A2A_OUTBOX_KINDS)[number];

/** Most bytes in one library file: 10 MB. */
export const LIBRARY_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Most bytes in one workspace's library: 1 GB. */
export const LIBRARY_MAX_BYTES = 1024 * 1024 * 1024;

export const LIBRARY_ENTRY_KINDS = ["file", "dir"] as const;
export type LibraryEntryKind = (typeof LIBRARY_ENTRY_KINDS)[number];

/** Where wiki pages live: the `wiki/` folder of the library. */
export const WIKI_ROOT = "wiki";

/** What a grant in `agent_library_access` allows on its path and below. */
export const LIBRARY_ACCESS_MODES = ["read", "write"] as const;
export type LibraryAccessMode = (typeof LIBRARY_ACCESS_MODES)[number];

/** One path an agent may read or write, as the claim and the settings page carry it. */
export interface LibraryAccessGrant {
  mode: LibraryAccessMode;
  path: string;
}

/** What a version row records: a write, a delete tombstone, a restore of an older version, or a move. */
export const LIBRARY_VERSION_OPS = [
  "write",
  "delete",
  "restore",
  "move",
] as const;
export type LibraryVersionOp = (typeof LIBRARY_VERSION_OPS)[number];

export const LIBRARY_CONFLICT_STATUSES = ["open", "resolved"] as const;
export type LibraryConflictStatus = (typeof LIBRARY_CONFLICT_STATUSES)[number];

/** `stale` means the page changed after the suggestion's base version, so it can no longer apply as written. */
export const WIKI_SUGGESTION_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "stale",
] as const;
export type WikiSuggestionStatus = (typeof WIKI_SUGGESTION_STATUSES)[number];

/** Days a version is kept regardless of count. Older versions beyond the newest `LIBRARY_VERSION_KEEP_MIN` per file are pruned. */
export const LIBRARY_VERSION_KEEP_DAYS = 30;

/** Newest versions per file that survive pruning however old they are. */
export const LIBRARY_VERSION_KEEP_MIN = 20;

/** The folder a run writes its own task output to. A task is one run, so a follow-up run gets its own folder. */
export const taskFolderPath = (slug: string, runId: string): string =>
  `agents/${slug}/tasks/${runId}`;

/** A change to library paths, for the notifier that tells open surfaces and daemons to refetch. */
export interface LibraryChange {
  /** The run that made the change, or null for a person's. */
  byRunId: string | null;
  paths: string[];
  workspaceId: string;
}

export const FILE_SOURCES = ["upload", "slack", "run", "library"] as const;
export type FileSource = (typeof FILE_SOURCES)[number];

export const EVENT_TYPES = [
  "app.reply_failed",
  "app.error",
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
  "run.dry_run_skipped",
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
  "connector.deleted",
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
  "slack.room_send_failed",
  "slack.message_sent",
  "slack.app_installed",
  "slack.app_revoked",
  "slack.batch_started",
  "slack.listen_mode_changed",
  "inbox.posted",
  "inbox.loop_stopped",
  "mail.received",
  "mail.held",
  "mail.sent",
  "mail.rejected",
  "mail.bounced",
  "mail.failed",
  "mail.expired",
  "mailbox.provisioned",
  "mailbox.failed",
  "machine.online",
  "machine.offline",
  "computer.online",
  "computer.offline",
  "computer.exec",
  "computer.file",
  "computer.takeover_requested",
  "computer.taken",
  "computer.handed_back",
  "browser.action",
  "agent.created",
  "agent.updated",
  "agent.address_reserved",
  "credential.created",
  "credential.revoked",
  "api_key.created",
  "admin.action",
  "library.write",
  "library.delete",
  "library.command",
  "library.conflict",
  "library.restore",
  "library.access",
  "library.conflict.resolved",
  "wiki.suggestion",
  "wiki.suggestion.decided",
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
  "skill.update_available",
  "skill.deleted",
  "qa.asked",
  "qa.answered",
  "qa.accepted",
  "qa.closed",
  "map.edited",
  "workspace.snapshot",
  "artifact.created",
  "artifact.published",
  "artifact.restored",
  "artifact.renamed",
  "artifact.audience_changed",
  "artifact.deleted",
  "artifact.share_created",
  "artifact.share_revoked",
  "artifact.links_switched",
  "artifact.promoted",
  "artifact.grant_decided",
  "artifact.handed_to",
  "artifact.member_added",
  "artifact.member_role_changed",
  "artifact.member_revoked",
  "artifact.guest_invited",
  "artifact.guest_code_sent",
  "artifact.guest_signed_in",
  "artifact.comment_created",
  "artifact.comment_resolved",
  "artifact.live_checkpoint",
  "artifact.agent_change_reverted",
  "artifact.guests_switched",
  "a2a.agent_published",
  "a2a.agent_unpublished",
  "a2a.invite_created",
  "a2a.invite_failed",
  "a2a.connection_created",
  "a2a.connection_requested",
  "a2a.connection_approved",
  "a2a.connection_declined",
  "a2a.connection_activated",
  "a2a.connection_revoked",
  "a2a.connection_reapproval_needed",
  "a2a.policy_changed",
  "a2a.message_received",
  "a2a.message_approved",
  "a2a.message_declined",
  "a2a.message_refused",
  "a2a.message_sent",
  "a2a.result_received",
  "a2a.task_cancelled",
  "a2a.rate_limited",
  "a2a.outbox_dropped",
  "a2a.pairing_switched",
  "a2a.pairing_requested",
  "a2a.pairing_code_wrong",
  "a2a.pairing_locked",
  "a2a.pairing_approved",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** A mailbox starts `provisioning`, turns `active` once its routing rule exists, and `failed` keeps the reason in `last_error`. */
export const MAILBOX_STATUSES = [
  "provisioning",
  "active",
  "failed",
  "disabled",
] as const;
export type MailboxStatus = (typeof MAILBOX_STATUSES)[number];

export const MAIL_DIRECTIONS = ["in", "out"] as const;
export type MailDirection = (typeof MAIL_DIRECTIONS)[number];

/**
 * Where a message stands. `held` waits for a person's approval, `rejected` was
 * denied, `expired` timed out unanswered, `bounced` came back undelivered and
 * `failed` never left.
 */
export const MAIL_MESSAGE_STATUSES = [
  "received",
  "held",
  "sent",
  "rejected",
  "expired",
  "bounced",
  "failed",
] as const;
export type MailMessageStatus = (typeof MAIL_MESSAGE_STATUSES)[number];

/** The tool name of an approval that holds an outgoing mail. */
export const MAIL_SEND_TOOL = "mail_send";

/** The tool key an "Always allow" on a mail recipient writes, one per address. */
export const mailToolKey = (address: string): string =>
  `mail:${address.trim().toLowerCase()}`;

/**
 * Payloads of the computer and browser events. None carries command output or
 * file bytes: those stay in the run's tool result and the files service.
 */
export interface ComputerPresencePayload {
  machineId: string;
}

export interface ComputerExecPayload {
  command: string;
  durationMs: number;
  /** Null when the process was killed or timed out. */
  exitCode: number | null;
  machineId: string;
}

export interface ComputerFilePayload {
  bytes: number;
  machineId: string;
  op: "get" | "put";
  path: string;
}

export interface ComputerTakeoverRequestedPayload {
  machineId: string;
  reason: string;
  requestId: string;
}

export interface ComputerTakenPayload {
  machineId: string;
  /** Clerk user id of the person who took over. */
  userId: string;
}

export interface ComputerHandedBackPayload {
  machineId: string;
  note?: string;
  userId: string;
}

export interface BrowserActionPayload {
  action: string;
  url?: string;
}

/**
 * Payloads of the Q&A, skill update and map events. Ids only, as `inbox.posted`
 * does, so no question text lands in the event log.
 */
export interface QaAskedPayload {
  questionId: string;
}

export interface QaAnsweredPayload {
  answerId: string;
  questionId: string;
}

export interface QaAcceptedPayload {
  answerId: string;
  questionId: string;
}

export interface QaClosedPayload {
  questionId: string;
}

export interface SkillUpdateAvailablePayload {
  commitSha: string;
  skillId: string;
}

export const MAP_EDIT_ACTIONS = ["moved", "reset"] as const;
export type MapEditAction = (typeof MAP_EDIT_ACTIONS)[number];

export interface MapEditedPayload {
  action: MapEditAction;
  nodeKey: string;
}

export const EVENT_ACTOR_KINDS = [
  "run",
  "guest",
  "user",
  "agent",
  "trigger",
  "system",
  "api_key",
  "peer",
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

/**
 * What the person chose for a connector. `auto` follows the server's own answer
 * to an unauthenticated probe. `oauth` and `none` are forced: no probe changes
 * them.
 */
export const CONNECTOR_AUTH_MODES = [
  "auto",
  "oauth",
  "header",
  "none",
] as const;
export type ConnectorAuthMode = (typeof CONNECTOR_AUTH_MODES)[number];

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

export const QA_STATUSES = ["open", "answered", "closed"] as const;
export type QaStatus = (typeof QA_STATUSES)[number];

/** Who wrote a question or answer: a person, or an agent's run. */
export const QA_AUTHOR_KINDS = ["user", "agent"] as const;
export type QaAuthorKind = (typeof QA_AUTHOR_KINDS)[number];

/** Limits the ask and answer paths both enforce. */
export const QA_TITLE_MAX = 200;
export const QA_BODY_MAX = 20_000;

/** Questions one agent may have open at once. */
export const QA_OPEN_PER_AGENT_MAX = 5;

/** Where a skill's files were imported from. GitHub only. */
export const SKILL_SOURCE_PROVIDERS = ["github"] as const;
export type SkillSourceProvider = (typeof SKILL_SOURCE_PROVIDERS)[number];

export const REQUEST_KINDS = [
  "approval",
  "question",
  "takeover",
  "decisions",
] as const;
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

/**
 * How much an agent asks before it acts. The first three are presets that
 * apply to every tool the agent has, new ones included. `custom` asks about
 * nothing on its own: the agent's `agent_tool_rules` rows decide, which is how
 * every agent ran before levels. Rows are overrides on any level.
 */
export const ASK_LEVELS = [
  "rarely",
  "outside",
  "everything",
  "custom",
] as const;
export type AskLevel = (typeof ASK_LEVELS)[number];

export const ANSWER_SURFACES = ["web", "slack", "a2a"] as const;
export type AnswerSurface = (typeof ANSWER_SURFACES)[number];

/** How long an approval stays open: one hour. */
export const APPROVAL_TTL_MS = 60 * 60_000;

/** How long a question stays open: one day. */
export const QUESTION_TTL_MS = 24 * 60 * 60_000;

/** How long a question from a run a peer set going stays open: one hour. */
export const PEER_QUESTION_TTL_MS = 60 * 60_000;

/** How long a takeover request stays open: as long as a question. */
export const TAKEOVER_TTL_MS = QUESTION_TTL_MS;

/** Most questions in one ask-user request. */
export const QUESTIONS_MAX = 4;

/** Most choices on one question. */
export const CHOICES_MAX = 6;

/** Most questions in one decision queue (`decisions` request). */
export const DECISIONS_MAX = 8;

/** Fewest and most options on one decision. A person may also type their own answer. */
export const DECISION_OPTIONS_MIN = 2;
export const DECISION_OPTIONS_MAX = 4;

/** How long a decision queue stays open: as long as a question. */
export const DECISIONS_TTL_MS = QUESTION_TTL_MS;

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
  "artifact_grant",
  "skill_proposal",
  "trigger_proposal",
  "routine_proposal",
  "inbox_reply",
  "library_conflict",
  "wiki_suggestion",
  "takeover",
  "a2a_message",
  "a2a_connection",
  "connector_secret",
  "memory_note",
  "spend_pause",
  "dream_question",
  "dream_held",
  "decisions",
] as const;
export type NeedsYouKind = (typeof NEEDS_YOU_KINDS)[number];

/** The heading of a Needs you card, from the name of the agent it is about. */
export const NEEDS_YOU_HEADINGS: Record<
  NeedsYouKind,
  (agentName: string) => string
> = {
  a2a_connection: (name) => `${name} has a connection waiting for approval`,
  a2a_message: (name) => `A message for ${name} waits for approval`,
  approval: (name) => `${name} asks for approval`,
  artifact_grant: (name) => `${name} asks for app permissions`,
  connector_secret: (name) => `${name} needs a connector secret`,
  decisions: (name) => `${name} has decisions waiting`,
  dream_held: (name) => `${name} has dream changes waiting for your approval`,
  dream_question: (name) => `${name} has a question from its dream`,
  inbox_reply: (name) => `${name} replied`,
  library_conflict: (name) => `${name} left a library conflict`,
  memory_note: (name) => `${name} wants to remember something`,
  question: (name) => `${name} asks`,
  routine_proposal: (name) => `${name} proposed a routine`,
  skill_proposal: (name) => `${name} proposed a skill change`,
  spend_pause: (name) => `${name} stopped at its weekly limit`,
  takeover: (name) => `${name} needs you to take over a computer`,
  trigger_proposal: (name) => `${name} proposed a trigger`,
  wiki_suggestion: (name) => `${name} suggested a wiki edit`,
};

/** An item older than this also shows in the backup's Mine. */
export const RAIL_ESCALATE_AFTER_MS = 4 * 60 * 60_000;

/** Mail approvals wait longer than other approvals, because no tool is blocked on them. */
export const MAIL_APPROVAL_TTL_MS = 3 * 24 * 60 * 60_000;

/** A run's change to a skill its agent does not own waits this long for a person, like a mail approval, then lapses. */
export const SKILL_CHANGE_TTL_MS = MAIL_APPROVAL_TTL_MS;

/** Window event: refetch the rail now. */
export const RAIL_REFRESH_EVENT = "hm:rail-refresh";

export type RailScope = "mine" | "everyone";
export type RailItemKind = NeedsYouKind | "problem";

export interface RailMail {
  /** The reply a person is approving, up to 4000 characters. */
  body: string;
  /** Without Re: or Fwd:. */
  subject: string;
  /** Snippet of the inbound message on the same thread. */
  theyWrote: string | null;
  to: string[];
}

/** One decision. A rail row holds one, or several when grouped. */
export interface RailCard {
  /** Set on the A2A kinds: who is asking and what they sent. */
  a2a?: A2aNeedsYou;
  /** The agent's stored tile, or the default for its name when the card has no stored agent. */
  agentAvatar: AgentAvatar;
  /** Empty when no agent is involved. */
  agentId: string;
  agentName: string;
  artifactId?: string;
  at: string;
  /** What the card is about, from the desk card's band: the version message, the skill name, the reply text. On a problem, the sentence that says what happened. */
  detail: string;
  /** Set on `dream_question`: the question and the notes to choose between. */
  dream?: DreamNeedsYou;
  /** Set on `dream_held`: the dream whose changes wait for approval. */
  dreamHeld?: DreamHeldNeedsYou;
  expiresAt: string | null;
  /** The source card's id, so request ids stay answerable. */
  id: string;
  kind: RailItemKind;
  mail: RailMail | null;
  passedOnBy: string | null;
  runId: string | null;
  /** What happened, in plain words: "Reply ready". */
  status: string;
  threadId: string | null;
  title: string;
}

export interface RailItem {
  /** Null means anyone. */
  assigneeName: string | null;
  assigneeUserId: string | null;
  /** At least one; the first gives the row its title. */
  cards: RailCard[];
  dueAt: string | null;
  escalatedToMe: boolean;
  /** Stable across polls: the first card's id. */
  id: string;
  mine: boolean;
}

export interface RailWorking {
  agentId: string;
  agentName: string;
  /** The run id. */
  id: string;
  mine: boolean;
  passedOnBy: string | null;
  status: string;
  title: string;
}

export interface RailView {
  /** Needs you, for the badge and the toggle. */
  counts: { everyone: number; mine: number };
  /** Finished today within the scope. */
  doneToday: number;
  /** Already filtered to the scope and sorted. */
  needsYou: RailItem[];
  /** Already filtered to the scope, newest first. */
  working: RailWorking[];
}

export interface WorkspaceMember {
  name: string;
  userId: string;
}

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
  "conflict",
] as const;
export type DeskCardKind = (typeof DESK_CARD_KINDS)[number];

/**
 * What a person decides on in an A2A Needs you card. Everything in it but the
 * ids comes from a peer, `peer`, `host`, `org` and `text` included: show it as
 * plain text, never as markup.
 */
export interface A2aNeedsYou {
  checkCode: string | null;
  connectionId: string;
  host: string | null;
  org: string | null;
  peer: string;
  text: string | null;
}

/** One card on the desk. */
export interface DeskCard {
  /** Set on an A2A card (`a2a_message`, `a2a_connection`). */
  a2a?: A2aNeedsYou;
  /** "user" when a person started the card. Name them from `startedBy`, not `agentId`. */
  actorKind?: "user";
  agentId: string;
  artifactId?: string;
  at: string;
  band: StatusBand;
  /** Set on a `dream_question` card. */
  dream?: DreamNeedsYou;
  /** Set on a `dream_held` card. */
  dreamHeld?: DreamHeldNeedsYou;
  /** Set on a `memory_note` card of a private note: the person it belongs to, who alone can decide it. */
  forUserId?: string;
  id: string;
  kind: DeskCardKind;
  lane: DeskLane;
  needsYouKind?: NeedsYouKind;
  runId?: string;
  startedBy: string;
  threadId?: string;
  title: string;
}

export const MAP_NODE_KINDS = ["trigger", "agent", "output"] as const;
export type MapNodeKind = (typeof MAP_NODE_KINDS)[number];

/** What starts an agent on the map. `slack` is an agent's Slack app, which is not a `triggers` row. The system's `dream` trigger is not drawn. */
export const MAP_TRIGGER_KINDS = [
  "http",
  "routine",
  "mail",
  "app",
  "slack",
] as const;
export type MapTriggerKind = (typeof MAP_TRIGGER_KINDS)[number];

/** Where an agent's work lands. */
export const MAP_OUTPUT_KINDS = ["slack", "library", "qa", "email"] as const;
export type MapOutputKind = (typeof MAP_OUTPUT_KINDS)[number];

/** What an agent carries: a connector, its computer, its browser, or a skill. */
export const MAP_PORT_KINDS = [
  "connector",
  "computer",
  "browser",
  "skill",
] as const;
export type MapPortKind = (typeof MAP_PORT_KINDS)[number];

export const MAP_WIRE_KINDS = [
  "trigger",
  "handoff",
  "slack",
  "library",
  "qa",
  "email",
] as const;
export type MapWireKind = (typeof MAP_WIRE_KINDS)[number];

/** A thing an agent node carries, drawn as a port on the node. */
export interface MapPort {
  /** The connector, machine or skill id, or the agent id for a browser. */
  id: string;
  kind: MapPortKind;
  label: string;
  /** Computer presence, when this is a computer port. */
  status?: string | null;
}

/**
 * One box on the map. `key` is what `map_positions.node_key` stores:
 * `trigger:<id>`, `trigger:slack:<slackAppId>`, `agent:<id>`,
 * `out:slack:<channel>`, `out:library:<folder>`, `out:qa` or `out:email:<agent>`.
 * `subkind` names the trigger or output type and is null for an agent.
 */
export interface MapNode<TRequest = unknown> {
  /** The agent's stored avatar. Set on agent nodes only. */
  avatar?: AgentAvatar;
  key: string;
  kind: MapNodeKind;
  label: string;
  /** Oldest visible pending request for the inspector. */
  pendingRequest?: TRequest;
  ports: MapPort[];
  subkind: MapTriggerKind | MapOutputKind | null;
  waiting?: boolean;
  x: number;
  y: number;
}

/** A line between two nodes, by key. `count7d` is the events over the last seven days. */
export interface MapWire {
  /** True when a run is going over this wire now. */
  active: boolean;
  /**
   * True when today's configuration draws this wire: a `triggers` row or slack
   * app, or a handoff in `hands_to`. A wire that only old events drew is
   * historical and not configured.
   */
  configured: boolean;
  count7d: number;
  from: string;
  kind: MapWireKind;
  to: string;
}

export interface MapGraph<TRequest = unknown> {
  nodes: MapNode<TRequest>[];
  wires: MapWire[];
}

/** `app` is phase 2: a micro app with a server part. Pages and dashboards are served the same way. */
export const ARTIFACT_KINDS = [
  "page",
  "doc",
  "dashboard",
  "app",
  "document",
  "deck",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** `private`: the owner and admins. `workspace`: every member. Phase 4 adds `people` and `public`. */
export const ARTIFACT_AUDIENCES = ["private", "workspace"] as const;
export type ArtifactAudience = (typeof ARTIFACT_AUDIENCES)[number];

export const ARTIFACT_AUTHOR_KINDS = ["user", "agent", "guest"] as const;
export type ArtifactAuthorKind = (typeof ARTIFACT_AUTHOR_KINDS)[number];

/** Phase 2: an agent's app version starts `proposed` until promoted, `rejected` when a person says no. */
export const ARTIFACT_VERSION_STATUSES = [
  "published",
  "proposed",
  "rejected",
] as const;
export type ArtifactVersionStatus = (typeof ARTIFACT_VERSION_STATUSES)[number];

/** Who a view token was minted for. `test` is the Browser Run token of `artifact_test`. */
export const ARTIFACT_VIEWER_KINDS = ["member", "link", "test"] as const;
export type ArtifactViewerKind = (typeof ARTIFACT_VIEWER_KINDS)[number];

/** Where an open happened. `live_call` is a tool call on a live link (phase 2). */
export const ARTIFACT_VIEW_SURFACES = [
  "viewer",
  "thread",
  "share",
  "test",
  "live_call",
  "guest",
  "room",
] as const;
export type ArtifactViewSurface = (typeof ARTIFACT_VIEW_SURFACES)[number];

/** `refused`, `rate_limited` and `error` are phase 2 outcomes of a live call. */
export const ARTIFACT_VIEW_OUTCOMES = [
  "ok",
  "revoked",
  "expired",
  "disabled",
  "refused",
  "rate_limited",
  "error",
] as const;
export type ArtifactViewOutcome = (typeof ARTIFACT_VIEW_OUTCOMES)[number];

export const ARTIFACT_SHARE_KINDS = ["link"] as const;
export type ArtifactShareKind = (typeof ARTIFACT_SHARE_KINDS)[number];

/** A `snapshot` link shows the data shipped in the version. A `live` link may call tools as its granter. */
export const ARTIFACT_SHARE_DATA_MODES = ["snapshot", "live"] as const;
export type ArtifactShareDataMode = (typeof ARTIFACT_SHARE_DATA_MODES)[number];

export const ARTIFACT_GRANT_KINDS = [
  "tool",
  "secret",
  "host",
  "endpoint",
  "agent",
] as const;
export type ArtifactGrantKind = (typeof ARTIFACT_GRANT_KINDS)[number];

export const ARTIFACT_GRANT_STATUSES = [
  "pending",
  "approved",
  "rejected",
] as const;
export type ArtifactGrantStatus = (typeof ARTIFACT_GRANT_STATUSES)[number];

export const ARTIFACT_PIN_SURFACES = ["sidebar", "desk"] as const;
export type ArtifactPinSurface = (typeof ARTIFACT_PIN_SURFACES)[number];

/** Most files in one artifact version. */
export const ARTIFACT_MAX_FILES = 200;

/** Most bytes in one artifact version, over all files: 16 MB. */
export const ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;

/** Most bytes in one artifact file: 10 MB. */
export const ARTIFACT_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Most bytes in one workspace's artifact blobs: 1 GB. */
export const ARTIFACT_WORKSPACE_MAX_BYTES = 1024 * 1024 * 1024;

/** Access-log rows older than this are deleted. */
export const ARTIFACT_VIEW_KEEP_DAYS = 365;

/** Most bytes of storage one micro app may hold (phase 2): 20 MB. */
export const ARTIFACT_APP_STORAGE_MAX_BYTES = 20 * 1024 * 1024;

/** Limits on a live link's tool calls (phase 2). */
export const ARTIFACT_LIVE_LINK_LIMITS = {
  perDay: 1000,
  perMinute: 60,
  perVisitorPerMinute: 10,
} as const;

/**
 * Payload of `artifact.published`, appended once per new version (create,
 * update or restore). It reaches the session stream and the thread fold, which
 * key the card on this event, not on the tool name. Never holds a token.
 */
export interface ArtifactPublishedPayload {
  artifactId: string;
  kind: ArtifactKind;
  runId: string | null;
  sessionId: string | null;
  title: string;
  /** The tool call that made the version, when an agent did. */
  toolCallId?: string;
  version: number;
  versionId: string;
}

export const LIVE_KINDS = ["document", "deck"] as const;
export type LiveKind = (typeof LIVE_KINDS)[number];
export const ARTIFACT_MEMBER_ROLES = ["viewer", "commenter", "editor"] as const;
export type ArtifactMemberRole = (typeof ARTIFACT_MEMBER_ROLES)[number];
export const GUEST_SESSION_HOURS = 12;
export const GUEST_CODE_MINUTES = 10;
export const GUEST_CODE_MAX_ATTEMPTS = 5;
export const GUEST_AGENT_RUNS_PER_DAY = 20;
export const ROOM_TICKET_SECONDS = 120;
export const ROOM_CONNECTION_MINUTES = 15;
export const LIVE_DOC_MAX_BYTES = 8 * 1024 * 1024;
export const LIVE_COMMENT_MAX_BYTES = 4096;
export const LIVE_THREADS_MAX = 1000;
export const LIVE_COMMENTS_PER_THREAD_MAX = 100;

export const SESSION_ORIGINS = [
  "ui",
  "slack",
  "mail",
  "inbox",
  "qa",
  "routine",
  "trigger",
  "mcp",
  "artifact",
  "a2a",
] as const;
export type SessionOrigin = (typeof SESSION_ORIGINS)[number] | "dry_run";

/** Live checkpoint notification; no document bytes or room credentials in events. */
export interface ArtifactLiveCheckpointPayload {
  artifactId: string;
  revision: number;
  sessionId: string;
  versionId: string;
}
export const LIVE_POSITION_ENCODING_VERSION = 1;
export const LIVE_AGENT_PRESENCE_CLEAR_MS = 5000;
export const LIVE_POINTER_UPDATES_PER_SECOND = 20;

/** The colours an agent's avatar can take. The default is picked from the first letter of the name. */
export const AGENT_AVATAR_COLORS = [
  "slate",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
] as const;
export type AgentAvatarColor = (typeof AGENT_AVATAR_COLORS)[number];

/** What `agents.avatar` holds as JSON: a colour and one glyph, usually the first letter of the name. */
export interface AgentAvatar {
  color: AgentAvatarColor;
  glyph: string;
}

const LOWERCASE_ASCII = /[a-z]/;
const NO_GLYPH = "?";

/**
 * The avatar a new agent gets. The glyph is the first character of the name, upper-cased when it is
 * ASCII, and the colour is picked by that character's code point. The migration that added the
 * column backfills with the same rule in SQL, so keep the two in step.
 */
export const defaultAgentAvatar = (name: string): AgentAvatar => {
  const [first] = Array.from(name);
  if (first === undefined) {
    return { color: AGENT_AVATAR_COLORS[0], glyph: NO_GLYPH };
  }
  const code = first.codePointAt(0) ?? 0;
  return {
    color: AGENT_AVATAR_COLORS[code % AGENT_AVATAR_COLORS.length] ?? "slate",
    glyph: LOWERCASE_ASCII.test(first) ? first.toUpperCase() : first,
  };
};

/** The avatar column's database default, for rows written without one. */
export const NEUTRAL_AGENT_AVATAR_JSON = JSON.stringify({
  color: "slate",
  glyph: NO_GLYPH,
} satisfies AgentAvatar);

/** The order a Roster card wall reads in: what needs a person first, idle agents last. */
export const AGENT_CARD_STATES = [
  "needs_you",
  "stopped",
  "working",
  "idle",
] as const;
export type AgentCardState = (typeof AGENT_CARD_STATES)[number];

/** How a finished agent's status line starts. The browser puts the finish time between "Done" and the colon. */
export const DONE_STATUS_PREFIX = "Done: ";

/** One agent on the Roster home. */
export interface AgentCard {
  avatar: AgentAvatar;
  /**
   * When the agent's last run finished, while the status line reads "Done: ...".
   * The browser prints the time in the viewer's own zone, so the line holds none.
   */
  doneAt: string | null;
  id: string;
  isLead: boolean;
  /** What the agent is for, one line. */
  jobLine: string;
  learnedCount: number;
  name: string;
  needsYouCount: number;
  /** Display name of the person who answers for the agent. */
  ownerName: string;
  slug: string;
  state: AgentCardState;
  /** What the agent is doing or waiting on, one plain line. */
  statusLine: string;
  /** The agent's home team, or null. */
  teamId: string | null;
  /** The weekly spend cap in cents, or null for no cap. */
  weeklyCapCents: number | null;
}

/** One app (connector) an agent may call, on the Keys tab. */
export interface AgentKeyApp {
  /** Tool names the agent may call, or null for every tool. */
  allowedTools: string[] | null;
  connectorId: string;
  connectorName: string;
  credentialMode: CredentialMode;
  credentials: {
    /** The agent's unattended sign-in, when this mode permits one. */
    agentSignIn: { ownerName: string; status: CredentialStatus } | null;
    /** Whether the caller has a stored sign-in, including one needing attention. */
    hasOwnSignIn: boolean;
    /** Other people's sign-ins; null unless the caller is an admin or effective owner. */
    otherSignIns: { ownerName: string; status: CredentialStatus }[] | null;
  };
  /** The sign-in for work on the caller's behalf. Null when it is missing. */
  signIn: {
    ownerKind: CredentialOwnerKind;
    ownerName: string;
    status: CredentialStatus;
  } | null;
}

/** One secret the agent is granted. The value is never part of this. */
export interface AgentKeySecret {
  id: string;
  kind: SecretMode;
  name: string;
}

/** One agent this agent is connected to, by A2A or inside the workspace. */
export interface AgentKeyConnection {
  connectionId: string;
  peerKind: A2aPeerKind;
  peerName: string;
  status: A2aConnectionStatus;
}

/** An agent this agent hands work to. */
export interface AgentKeyHandsTo {
  agentId: string;
  name: string;
}

/** A tool the agent asks about (or not) whatever its level says. */
export interface AgentKeyAskOverride {
  mode: ToolRuleMode;
  toolKey: string;
}

/** Everything the Keys tab shows for one agent, in five parts. */
export interface AgentKeys {
  apps: AgentKeyApp[];
  asksBefore: {
    level: AskLevel;
    overrides: AgentKeyAskOverride[];
  };
  identity: {
    /** The agent's email address, or null when it has none. */
    emailAddress: string | null;
    /** The state of the agent's Slack app, or null when it has none. */
    slackApp: SlackAppStatus | null;
  };
  otherAgents: {
    connections: AgentKeyConnection[];
    handsTo: AgentKeyHandsTo[];
  };
  secrets: AgentKeySecret[];
}

/** One app the workspace can add from the catalogue. */
export interface CatalogEntry {
  authKind: ConnectorAuthKind;
  /** Tool names a new agent may call by default. */
  defaultAllowedTools: string[];
  description: string;
  icon: string;
  key: string;
  name: string;
  url: string;
}

/** What starts a job. The first four are trigger kinds; `slack` is a message to the agent's Slack app. */
export const JOB_SOURCES = ["routine", "http", "mail", "app", "slack"] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

/** One way an agent starts, read as a sentence: when, what it does, who it asks first and where the result goes. */
export interface JobSentence {
  agent: { id: string; name: string };
  /** Who the agent asks before it acts, in words. Null when it asks no one. */
  asksBefore: string | null;
  /** True for a start an agent's run proposed that no person has approved yet. It is never enabled. */
  awaitingApproval: boolean;
  /** Where the result goes, in words. Null when nowhere in particular. */
  deliversTo: string | null;
  /** What the agent does, in words. */
  does: string;
  enabled: boolean;
  /** The trigger or routine row this sentence reads, or the Slack app id for `slack`. */
  id: string;
  /** When the last run started, as an ISO time. Null when it has not run. */
  lastRunAt: string | null;
  /** Whether the last run ended well. Null when it has not run. */
  lastRunOk: boolean | null;
  /** When a routine fires next, as an ISO time. Null for a start that has no schedule. */
  nextRunAt: string | null;
  source: JobSource;
  /** What starts it, in words: "Every weekday at 9:00", "When mail arrives". */
  when: string;
}

/** A job the model proposes from a person's text, for the person to review before it is saved. */
export interface ProposedTrigger {
  asksBefore: string | null;
  /** Five-field cron for a routine, read in `timezone`. Null for every other source. */
  cron: string | null;
  deliversTo: string | null;
  does: string;
  source: JobSource;
  /** An IANA zone for a routine. Null for every other source. */
  timezone: string | null;
  when: string;
}

/** The longest a note's text may be, in characters. It is one line. */
export const MEMORY_NOTE_MAX_CHARS = 500;

/** What a memory note is about. Each kind has its own file under `agents/<slug>/memory/`. */
export const MEMORY_NOTE_KINDS = [
  "people",
  "corrections",
  "work",
  "places",
] as const;
export type MemoryNoteKind = (typeof MEMORY_NOTE_KINDS)[number];

/** Who wrote a note: a person, the agent during work, or a dream. */
export const MEMORY_WRITERS = ["person", "agent", "dream"] as const;
export type MemoryWriter = (typeof MEMORY_WRITERS)[number];

/** What a note came from. A note a person typed on the Knows tab has no source. */
export const MEMORY_SOURCE_KINDS = ["session", "run", "request"] as const;
export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

export const MEMORY_CHANGE_ACTIONS = [
  "add",
  "edit",
  "forget",
  "merge",
] as const;
export type MemoryChangeAction = (typeof MEMORY_CHANGE_ACTIONS)[number];

/** `held` waits for a person, `undone` was applied and then reverted. */
export const MEMORY_CHANGE_STATUSES = [
  "applied",
  "held",
  "rejected",
  "undone",
] as const;
export type MemoryChangeStatus = (typeof MEMORY_CHANGE_STATUSES)[number];

/** How an agent learns: hold every note, apply and tell the owner, or apply quietly. */
export const LEARN_LEVELS = ["ask_first", "tell_after", "quiet"] as const;
export type LearnLevel = (typeof LEARN_LEVELS)[number];

export const DREAM_SCHEDULES = ["nightly", "weekly", "off"] as const;
export type DreamSchedule = (typeof DREAM_SCHEDULES)[number];

/** The session, run or request a note came from. */
export interface MemorySource {
  id: string;
  kind: MemorySourceKind;
}

/** One note in an agent's memory, as the note block in `docs/v4/memory-format.md` holds it. */
export interface MemoryNote {
  /** The day it was written, `YYYY-MM-DD` in UTC. */
  date: string;
  id: string;
  kind: MemoryNoteKind;
  source: MemorySource | null;
  text: string;
  /** The person a private note belongs to (a Clerk user id), or null for a note everyone the agent works for can read. */
  userScope: string | null;
  writtenBy: MemoryWriter;
}

/** One row of the memory log: a change made, held for a person, rejected or undone. */
export interface MemoryChange {
  action: MemoryChangeAction;
  /** The agent whose memory changed. Null on a team memory change, which has a `teamId` instead. */
  agentId: string | null;
  createdAt: string;
  /** When a person approved or rejected a held change, or undid an applied one. */
  decidedAt: string | null;
  /** Clerk user id of that person. */
  decidedBy: string | null;
  /** The dream that made the change, or null. */
  dreamRunId: string | null;
  /** Set on the rows of one merge: the id of its `merge` row. Null for every other change. */
  groupId: string | null;
  id: string;
  kind: MemoryNoteKind;
  /** The library version the change wrote. Null while held and when rejected. */
  libraryVersionId: string | null;
  noteId: string;
  source: MemorySource | null;
  status: MemoryChangeStatus;
  /** The team whose memory changed. Null on an agent's memory change. A row has an agent or a team, never both. */
  teamId: string | null;
  /** The note's text after the change. For `forget`, the text that was forgotten. */
  text: string;
  userScope: string | null;
  writtenBy: MemoryWriter;
}

/** What the owner tells one agent to keep and how it learns. The `agents.remember` column holds this as JSON. */
export interface RememberRules {
  dreamSchedule: DreamSchedule;
  learnLevel: LearnLevel;
  /** Topics this agent never keeps, added to the workspace's. */
  never: string[];
  /** What this agent should keep, in the owner's words. */
  remember: string[];
  /** Whether the team dream may lift this agent's notes into team memory. */
  shareWithTeam: boolean;
}

export const DEFAULT_REMEMBER_RULES: RememberRules = {
  dreamSchedule: "nightly",
  learnLevel: "tell_after",
  never: [],
  remember: [],
  shareWithTeam: true,
};

/** The `agents.remember` column's database default. */
export const DEFAULT_REMEMBER_RULES_JSON = JSON.stringify(
  DEFAULT_REMEMBER_RULES
);

/** What no agent in a workspace keeps, until the workspace changes the list. */
export const DEFAULT_NEVER_REMEMBER = [
  "Passwords and keys",
  "Card and bank numbers",
  "Health details",
] as const;

/** The `workspaces.never_remember` column's database default. */
export const DEFAULT_NEVER_REMEMBER_JSON = JSON.stringify(
  DEFAULT_NEVER_REMEMBER
);

/** The rules that govern one agent's memory: its own, and the workspace's never list that every agent inherits. */
export interface MemoryRules {
  agent: RememberRules;
  workspaceNever: string[];
}

/** The model a dream runs on: cheap, because a dream reads a lot and writes a little. */
export const DREAM_MODEL = "claude-haiku-5-5";

/** `running` until it ends. `skipped` found nothing new, `failed` left memory unchanged, `undone` was rolled back by a person. */
export const DREAM_RUN_STATUSES = [
  "running",
  "done",
  "skipped",
  "failed",
  "undone",
] as const;
export type DreamRunStatus = (typeof DREAM_RUN_STATUSES)[number];

/** What a dream changed, counted for the diary line. `questions` are contradictions it could not settle. */
export interface DreamCounts {
  added: number;
  dropped: number;
  merged: number;
  questions: number;
}

/** The `dream_runs.counts` column's database default. */
export const DEFAULT_DREAM_COUNTS_JSON = JSON.stringify({
  added: 0,
  dropped: 0,
  merged: 0,
  questions: 0,
} satisfies DreamCounts);

/** What the dream's model calls used. The same fields as a run's usage. */
export interface DreamUsage {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** One proposed change to an agent's notes. A note is named by its id in `agents/<slug>/memory/`. */
export type DreamPlanChange =
  | {
      action: "add";
      kind: MemoryNoteKind;
      /** The id the note is written under, so a question in the same plan can name it. A plan from outside a dream may leave it out, and the row gets one. */
      noteId?: string;
      source: MemorySource | null;
      text: string;
      userScope: string | null;
    }
  | {
      action: "merge";
      /** The notes folded into `keepNoteId`, which keeps its id and takes `text`. */
      absorbedNoteIds: string[];
      keepNoteId: string;
      text: string;
    }
  | { action: "drop"; noteId: string; reason: string }
  | {
      action: "question";
      /** The notes that disagree. */
      noteIds: string[];
      question: string;
    };

/** What a dream proposes before anything is written, in the order it applies. */
export type DreamPlan = DreamPlanChange[];

/** One dream of one agent or one team. Its note changes are the `memory_changes` rows that name it in `dreamRunId`. */
export interface DreamRun {
  /** The agent that dreamed. Null on a team dream, which has a `teamId` instead. */
  agentId: string | null;
  /**
   * The latest library version id of each memory file that existed before the
   * dream wrote anything. Undo restores them. A file the dream created has no
   * entry: find its versions through the run's `memory_changes` rows.
   */
  baseVersion: string[];
  counts: DreamCounts;
  /** The plain-words entry the owner reads. Empty until the run ends. */
  diary: string;
  /** Why the run `failed`. Null otherwise. */
  error: string | null;
  finishedAt: string | null;
  /** How many of its changes still wait for the owner's approval. Zero once decided, and on a dream that held nothing. */
  heldChanges: number;
  id: string;
  /** The library version id the dream wrote last, or null when it wrote nothing. A dream may write several files; every version it wrote is on a `memory_changes` row that names it. */
  resultVersion: string | null;
  /** The start of the window the dream read: when the agent's previous dream began, or null for its first. */
  since: string | null;
  startedAt: string;
  status: DreamRunStatus;
  /** The team that dreamed. Null on an agent's dream. A row has an agent or a team, never both. */
  teamId: string | null;
  usage: DreamUsage | null;
}

export const DREAM_QUESTION_STATUSES = ["open", "answered"] as const;
export type DreamQuestionStatus = (typeof DREAM_QUESTION_STATUSES)[number];

/** One of the notes a dream question asks a person to choose between. `text` is the note's text when the dream asked. */
export interface DreamQuestionOption {
  noteId: string;
  text: string;
}

/** A contradiction a dream could not settle. The answer keeps one option's note and drops the others. */
export interface DreamQuestion {
  /** The agent the question is about. Null on a team dream's question, which has a `teamId` instead. */
  agentId: string | null;
  /** When a person answered. Null while open. */
  answeredAt: string | null;
  /** Clerk user id of that person. */
  answeredBy: string | null;
  /** The option they kept. Null while open. */
  answeredNoteId: string | null;
  createdAt: string;
  dreamRunId: string;
  id: string;
  /** The notes that disagree, at least two. */
  options: DreamQuestionOption[];
  question: string;
  status: DreamQuestionStatus;
  /** The team the question is about, asked of its owner. Null on an agent's question. */
  teamId: string | null;
}

/** What a `dream_question` Needs you card holds: the question and one button per option. */
export interface DreamNeedsYou {
  options: DreamQuestionOption[];
  question: string;
  questionId: string;
}

/** What a `dream_held` Needs you card holds: the dream whose batch waits for its owner. */
export interface DreamHeldNeedsYou {
  dreamRunId: string;
}

/** What a person decides on a dream held by the `ask_first` learn level: all of its changes, or none. */
export const DREAM_DECISIONS = ["approve", "reject"] as const;
export type DreamDecision = (typeof DREAM_DECISIONS)[number];

/** Why an agent is paused: it reached its weekly cap, or a person paused it. */
export const SPEND_PAUSE_REASONS = ["spend_cap", "manual"] as const;
export type SpendPauseReason = (typeof SPEND_PAUSE_REASONS)[number];

/** What one agent, or one team's dreams, spent on one day, from usage. */
export interface SpendRow {
  /** The agent that spent. Null on a team's row, which has no agent. */
  agentId: string | null;
  /** Cents spent on the day. */
  cents: number;
  /** The day as `YYYY-MM-DD`. */
  day: string;
  /** How many runs that day counts. */
  tasks: number;
  /** The team whose dreams spent it. Set only on a team's row, where `agentId` is null. */
  teamId?: string;
}

/** An agent's pause state. Both fields are null while it runs. */
export interface SpendPause {
  pausedAt: string | null;
  pausedReason: SpendPauseReason | null;
}

/** A weekly cap after `setCap`. `agentId` is null for the workspace cap, `weeklyCapCents` null for none. */
export interface SpendCap {
  agentId: string | null;
  weeklyCapCents: number | null;
}

/** An agent's pause and cap after `resume`. */
export interface SpendResume extends SpendPause {
  weeklyCapCents: number | null;
}

/** One agent's cap and pause, on the spend page. */
export interface AgentSpendCap extends SpendPause {
  agentId: string;
  weeklyCapCents: number | null;
}

/** Every cap and pause in the workspace: its own cap and one entry per agent. */
export interface SpendCaps {
  agents: AgentSpendCap[];
  /** The workspace cap in cents, or null for none. */
  workspaceCapCents: number | null;
}

/** Who sits in a team, or in a topic limited to some members. */
export const TEAM_MEMBER_KINDS = ["agent", "user"] as const;
export type TeamMemberKind = (typeof TEAM_MEMBER_KINDS)[number];

/** How hard an agent thinks. Stored as `effort` in the agent's `runtimeConfig`. */
export const EFFORT_LEVELS = ["low", "medium", "high"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** How much context an agent loads. Stored as `contextBudget` in the agent's `runtimeConfig`. */
export const CONTEXT_BUDGETS = ["small", "standard", "large"] as const;
export type ContextBudget = (typeof CONTEXT_BUDGETS)[number];

/**
 * The context an agent may fill, in tokens, before a runtime compacts its
 * history. The one place the three budgets become numbers. An agent with no
 * `contextBudget` keeps the runtime's own default and is not in this table.
 */
export const CONTEXT_BUDGET_COMPACTION_TOKENS: Record<ContextBudget, number> = {
  large: 500_000,
  small: 100_000,
  standard: 200_000,
};

/**
 * The agent's `runtimeConfig` for a run at this subagent level. A subagent
 * keeps its own settings (docs/v3/subagents.md), so it takes neither the
 * agent's thinking level nor its context budget.
 */
export const runtimeConfigForRun = (
  runtimeConfig: Record<string, unknown>,
  subagentLevel: number
): Record<string, unknown> => {
  if (subagentLevel <= 0) {
    return runtimeConfig;
  }
  const { contextBudget: _budget, effort: _effort, ...rest } = runtimeConfig;
  return rest;
};

/** The agent's thinking level, or undefined when it has none or holds a value that is not one. */
export const effortOf = (
  runtimeConfig: Record<string, unknown>
): EffortLevel | undefined =>
  EFFORT_LEVELS.find((level) => level === runtimeConfig.effort);

/** The agent's context budget, or undefined when it has none or holds a value that is not one. */
export const contextBudgetOf = (
  runtimeConfig: Record<string, unknown>
): ContextBudget | undefined =>
  CONTEXT_BUDGETS.find((budget) => budget === runtimeConfig.contextBudget);

/** One seat in a team: an agent or a person. */
export interface TeamMember {
  /** True when this is the member's home team. An agent has at most one. */
  isHome: boolean;
  /** The agent id or the Clerk user id, by `memberKind`. */
  memberId: string;
  memberKind: TeamMemberKind;
  teamId: string;
}

/** A team: a lead, members and a team room. A team room is the forum inbox scoped to the team. */
export interface Team {
  /** When the team was archived, ISO, or null while it is live. */
  archivedAt: string | null;
  createdAt: string;
  /** The library folder the team's files live in, or null before one exists. */
  folderPath: string | null;
  id: string;
  /** The agent that leads the team, or null for a team with no lead. */
  leadAgentId: string | null;
  /** Whether a room message that names nobody goes to the lead. */
  leadListens: boolean;
  members: TeamMember[];
  name: string;
  /** Clerk user id of the person who answers for the team, or null. */
  ownerUserId: string | null;
  /** The team's rules, shown to every member above the untrusted block. */
  rules: string;
  slug: string;
}

/** The Slack channel a team room is linked to. One channel per team, one team per channel. */
export interface TeamSlackLink {
  channelId: string;
  createdAt: string;
  /** Clerk user id of the person who linked the channel. */
  linkedBy: string;
  /** Slack's id for the Slack workspace the channel is in. */
  slackTeamId: string;
  teamId: string;
}

/** One agent member of a team and its Slack app, as the linked channel sees it. */
export interface TeamSlackMemberApp {
  agentId: string;
  /** Slack's bot user id for the agent's app in the linked Slack workspace, or null when the agent has no installed app there. */
  botUserId: string | null;
  /** Whether the agent's bot is a member of the linked channel. False when the agent has no app there. */
  inChannel: boolean;
}

/** A team's Slack link and which of its member agents are in the channel. */
export interface TeamSlackStatus {
  /** The agent members of the team, each with its Slack app state. Empty while the team has no link. */
  apps: TeamSlackMemberApp[];
  /** The linked channel's name, or null while the team has no link or Slack gave no name. */
  channelName: string | null;
  /** The link, or null while the team's room is not linked to a channel. */
  link: TeamSlackLink | null;
}

/** One Slack channel a team's lead app can post in. */
export interface TeamSlackChannel {
  id: string;
  isPrivate: boolean;
  name: string;
}

/** The channels a team's lead app can see, for the link picker. */
export interface TeamSlackChannels {
  channels: TeamSlackChannel[];
  /** Slack's id for the workspace the channels are in, or null when no member agent has an installed Slack app. */
  slackTeamId: string | null;
}

/** How a person is named and mentioned in team rooms. */
export interface MemberProfile {
  /** Unique per workspace, lowercase. */
  handle: string;
  name: string;
  /** Clerk user id. */
  userId: string;
}

export const DISCUSSION_STATUSES = ["running", "done", "stopped"] as const;
export type DiscussionStatus = (typeof DISCUSSION_STATUSES)[number];

/** Most rounds a lead may ask for in one discussion. */
export const DISCUSSION_ROUNDS_MAX = 5;

/** A lead-run discussion in a team room topic: bounded rounds in which every topic member posts once. */
export interface Discussion {
  createdAt: string;
  id: string;
  /** The round now open, from 1. Equals `rounds` on the last. */
  round: number;
  /** How many rounds the lead asked for, 1 to `DISCUSSION_ROUNDS_MAX`. */
  rounds: number;
  /** The lead that started it. */
  startedByAgentId: string;
  status: DiscussionStatus;
  /** The inbox thread (the topic) it runs in. */
  threadId: string;
}

/** The team every workspace has. It holds the threads made before teams existed and the ones made with no team named. */
export const EVERYONE_TEAM_NAME = "Everyone";
export const EVERYONE_TEAM_SLUG = "everyone";
