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

export interface McpPorts {
  getRun: (input: { runId: string }) => Promise<RunInfo>;
  inboxList: () => Promise<ThreadInfo[]>;
  inboxPost: (input: { text: string; threadId: string }) => Promise<PostedInfo>;
  inboxRead: (input: { threadId: string }) => Promise<ThreadTranscript>;
  listAgents: () => Promise<AgentInfo[]>;
  listSessions: (input: { agent: string }) => Promise<SessionInfo[]>;
  readSession: (input: { sessionId: string }) => Promise<SessionTranscript>;
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
}

/** The longest a send_message call waits, in milliseconds. */
export const SEND_WAIT_MAX_MS = 25_000;
