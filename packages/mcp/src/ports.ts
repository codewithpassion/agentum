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

export interface McpPorts {
  getRun: (input: { runId: string }) => Promise<RunInfo>;
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
