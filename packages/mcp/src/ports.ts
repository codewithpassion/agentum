/**
 * What the platform tools need from the app. The app builds one `McpPorts` per
 * request, already bound to the caller's principal and workspace, so a tool
 * never sees who is asking. A port throws `ToolError` for a failure the agent
 * should read (see result.ts). This package imports no service.
 */

/** An agent the caller may message. `slug` is what tools take as `agent`. */
export interface AgentInfo {
  id: string;
  name: string;
  slug: string;
}

/** A run as the tools show it. `answer` is set once the run is `done`. */
export interface RunInfo {
  agentId: string;
  answer: string | null;
  error: string | null;
  runId: string;
  sessionId: string;
  /** One of queued, offered, running, done, failed, cancelled, interrupted. */
  status: string;
}

export interface SessionInfo {
  createdAt: string;
  id: string;
  lastRunAt: string | null;
  origin: string;
  /** Status of the latest run, or null when the session has none. */
  status: string | null;
  /** The first message, shortened. */
  title: string;
}

export interface TranscriptEntry {
  createdAt: string;
  /** `message.user`, `message.assistant`, `tool.call` or `tool.result`. */
  payload: Record<string, unknown>;
  type: string;
}

export interface SessionTranscript {
  entries: TranscriptEntry[];
  session: SessionInfo;
}

export interface SearchHit {
  /** Short excerpts around the matches, newest first. */
  passages: string[];
  session: SessionInfo;
}

/** An inbox thread as the tools show it. */
export interface ThreadInfo {
  createdAt: string;
  id: string;
  lastPostAt: string;
  title: string;
}

export interface PostInfo {
  /** The user id, or the agent id. */
  authorId: string;
  /** `user` or `agent`. */
  authorKind: string;
  createdAt: string;
  id: string;
  /** Set on an agent's post: the run that wrote it. */
  runId: string | null;
  text: string;
}

/** A thread with its newest posts, oldest first. */
export interface ThreadTranscript {
  posts: PostInfo[];
  thread: ThreadInfo;
}

/** A run that a post's mention started. */
export interface WokenRunInfo {
  agentId: string;
  runId: string;
}

export interface PostedInfo {
  post: PostInfo;
  /** The runs the post's `@slug` mentions started. Empty when none did. */
  runs: WokenRunInfo[];
}

/**
 * Where a routine or trigger stands. `awaiting_approval` is a proposal from an
 * agent's run: it is off until a person approves it in the Harbourmaster UI.
 */
export type AutomationStatus = "active" | "awaiting_approval" | "paused";

/** A routine: an agent started on a cron schedule. */
export interface RoutineInfo {
  agentId: string;
  agentName: string;
  cron: string;
  id: string;
  lastFiredAt: string | null;
  name: string;
  /** The next time it fires. Null while it is paused or awaiting approval. */
  nextRunAt: string | null;
  prompt: string;
  status: AutomationStatus;
  /** An IANA zone, in which the cron is read. */
  timezone: string;
}

/** An HTTP trigger: an outside system starts an agent with a secret. */
export interface TriggerInfo {
  agentId: string;
  agentName: string;
  id: string;
  lastFiredAt: string | null;
  name: string;
  status: AutomationStatus;
  /** The start of the secret, to tell triggers apart. Empty while awaiting approval. */
  tokenPrefix: string;
}

/** A trigger after it was created or switched on. `secret` is the only copy, and null when there is none to show. */
export interface TriggerChange {
  secret: string | null;
  trigger: TriggerInfo;
}

/** What a `bash` call returns. A non-zero exit code is a normal result, not an error. */
export interface LibraryBashResult {
  exitCode: number;
  stderr: string;
  /** True when the library cut stderr at 64 KB. The text then ends with a truncation note. */
  stderrTruncated: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  /** Library storage calls the script made. */
  storageCalls: number;
  wallMs: number;
}

/**
 * The owner of a skill. Names are unique per owner, so two skills can share a
 * name: show the owner wherever a name is shown. `agentId` is null for the people's skills.
 */
export interface SkillOwner {
  agentId: string | null;
  /** "people", or the owning agent's name. */
  name: string;
}

/** An agent that carries a skill. `version` is the one it uses now, the pinned one when `pinned`. */
export interface SkillAssignee {
  agentId: string;
  name: string;
  pinned: boolean;
  slug: string;
  version: number;
}

export interface SkillInfo {
  /** The agents that carry it with an approved version. */
  assignedTo: SkillAssignee[];
  id: string;
  /** The newest approved version, or null while none is approved. */
  latestApprovedVersion: number | null;
  /** The newest version that is not rejected. */
  latestVersion: number | null;
  name: string;
  owner: SkillOwner;
  /** The numbers of versions that wait for a person to approve them. */
  pendingProposals: number[];
}

/** One version of a skill. */
export interface SkillVersionInfo {
  /** Set once approved. */
  approvedAt: string | null;
  /** `user`, `agent` or `system`. */
  authorKind: string;
  createdAt: string;
  message: string;
  number: number;
  /** The version this one was made on, null for version 1. */
  parent: number | null;
  skillId: string;
  skillName: string;
  /** One of approved, proposed, rejected. */
  status: string;
}

export interface SkillFileInfo {
  executable: boolean;
  path: string;
  size: number;
}

/** A file's content: UTF-8 text, or base64 for a file that is not text. */
export interface SkillFileContent {
  content: string;
  encoding: "base64" | "utf8";
  path: string;
}

/** A version's file tree, and one file's content when a path was asked for. */
export interface SkillShown {
  file: SkillFileContent | null;
  files: SkillFileInfo[];
  version: SkillVersionInfo;
}

export interface SkillDiffInfo {
  added: string[];
  changed: string[];
  /** A unified diff of each added, removed or changed text file. */
  patches: { patch: string; path: string }[];
  removed: string[];
}

/** One file of a commit. `encoding` says how `content` is read. */
export interface SkillFileWrite {
  content: string;
  encoding: "base64" | "utf8";
  executable?: boolean;
  path: string;
}

export interface SkillAssignment {
  agentId: string;
  /** Null: the agent follows the latest approved version. */
  pinnedVersion: number | null;
  skillId: string;
}

export interface SkillImported {
  /** False when the archive made a new version of a skill the caller already owned. */
  created: boolean;
  name: string;
  version: SkillVersionInfo;
}

export interface SkillArchive {
  /** The `.skill` file, base64 encoded. */
  archiveBase64: string;
  filename: string;
}

/** The channels the agent's Slack bot is in, and the people it may message. */
export interface SlackDestinations {
  channels: { id: string; isPrivate: boolean; name: string }[];
  people: { email: string; slackName: string }[];
}

/** A message slack_send started. `permalink` is null when Slack gave none. */
export interface SlackSendResult {
  channel: string;
  permalink: string | null;
  /** The target as resolved: `#name`, or a person's email. */
  to: string;
  ts: string;
}

export interface McpPorts {
  approveSkillVersion: (input: {
    skillId: string;
    version: number;
  }) => Promise<SkillVersionInfo>;
  assignSkill: (input: {
    agent: string;
    skillId: string;
  }) => Promise<SkillAssignment>;
  commitSkill: (input: {
    baseVersion: number;
    deletes: string[];
    message: string;
    skillId: string;
    writes: SkillFileWrite[];
  }) => Promise<SkillVersionInfo>;
  createRoutine: (input: {
    agentId: string;
    cron: string;
    name: string;
    prompt: string;
    timezone?: string;
  }) => Promise<RoutineInfo>;
  createSkill: (input: {
    files: SkillFileWrite[];
    message: string;
    name: string;
  }) => Promise<SkillVersionInfo>;
  createTrigger: (input: {
    agentId: string;
    name: string;
  }) => Promise<TriggerChange>;
  deleteRoutine: (input: { routineId: string }) => Promise<void>;
  deleteTrigger: (input: { triggerId: string }) => Promise<void>;
  exportSkill: (input: {
    skillId: string;
    version: number;
  }) => Promise<SkillArchive>;
  getRun: (input: { runId: string }) => Promise<RunInfo>;
  importSkill: (input: { archiveBase64: string }) => Promise<SkillImported>;
  inboxList: () => Promise<ThreadInfo[]>;
  inboxPost: (input: { text: string; threadId: string }) => Promise<PostedInfo>;
  inboxRead: (input: { threadId: string }) => Promise<ThreadTranscript>;
  /** Runs a bash script over the workspace file library. */
  libraryBash: (input: { script: string }) => Promise<LibraryBashResult>;
  listAgents: () => Promise<AgentInfo[]>;
  listRoutines: (input: { agentId?: string }) => Promise<RoutineInfo[]>;
  listSessions: (input: { agent: string }) => Promise<SessionInfo[]>;
  listSkills: () => Promise<SkillInfo[]>;
  listTriggers: (input: { agentId?: string }) => Promise<TriggerInfo[]>;
  pinSkill: (input: {
    agent: string;
    skillId: string;
    version: number | null;
  }) => Promise<SkillAssignment>;
  readSession: (input: { sessionId: string }) => Promise<SessionTranscript>;
  rejectSkillVersion: (input: {
    skillId: string;
    version: number;
  }) => Promise<SkillVersionInfo>;
  revertSkill: (input: {
    message?: string;
    skillId: string;
    toVersion: number;
  }) => Promise<SkillVersionInfo>;
  searchSessions: (input: {
    agent: string;
    query: string;
  }) => Promise<SearchHit[]>;
  /** Starts a run and waits up to `waitMs` (0 to 25000) for it to finish. */
  sendMessage: (input: {
    agent: string;
    requestId?: string;
    text: string;
    waitMs: number;
  }) => Promise<RunInfo>;
  setRoutineEnabled: (input: {
    enabled: boolean;
    routineId: string;
  }) => Promise<RoutineInfo>;
  setTriggerEnabled: (input: {
    enabled: boolean;
    triggerId: string;
  }) => Promise<TriggerChange>;
  skillDiff: (input: {
    from: number;
    skillId: string;
    to: number;
  }) => Promise<SkillDiffInfo>;
  skillLog: (input: { skillId: string }) => Promise<SkillVersionInfo[]>;
  /** The version's tree, and the content of `path` when it is given. */
  skillShow: (input: {
    path?: string;
    skillId: string;
    version: number;
  }) => Promise<SkillShown>;
  slackDestinations: () => Promise<SlackDestinations>;
  slackSend: (input: {
    text: string;
    thread_ts?: string;
    to: string;
  }) => Promise<SlackSendResult>;
  unassignSkill: (input: { agent: string; skillId: string }) => Promise<void>;
}

/** The longest a send_message call waits, in milliseconds. */
export const SEND_WAIT_MAX_MS = 25_000;
