import type { McpServerEntry } from "../connectors/mcp-servers.ts";

/** What the runner needs to work one run. Everything in it is safe to store. */
export interface CloudStart {
  agent: {
    id: string;
    instructions: string;
    model: string;
    name: string;
    runtimeConfig: Record<string, unknown>;
    slug: string;
  };
  inputFileIds: string[];
  mcpServers: Record<string, McpServerEntry>;
  run: {
    agentId: string;
    id: string;
    inputText: string;
    sessionId: string;
    workspaceId: string;
  };
  runToken: string;
}

/**
 * The services' view of the cloud runner: one Durable Object per session
 * (built in C.3). The app supplies the port, the way it does for the machine
 * relay.
 */
export interface CloudRunnerPort {
  /** Stops the run's work. Best effort. */
  cancel: (runId: string, sessionId: string) => Promise<void>;
  /** Starts working the run. Idempotent on `run.id`: a repeat start does nothing. */
  start: (input: CloudStart) => Promise<void>;
}
