// Safe to import from browser code: no driver, no Node APIs. Everything the UI
// needs from this package lives here; the other entries pull in drizzle. The
// schema takes its enum values from here too, so the UI and the tables agree.

export const AGENT_RUNTIMES = ["machine", "managed", "fake"] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

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

export const FILE_SOURCES = ["upload", "slack", "run"] as const;
export type FileSource = (typeof FILE_SOURCES)[number];
