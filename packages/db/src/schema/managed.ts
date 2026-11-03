import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { createdAt, workspaceId } from "../columns.ts";
import { agents } from "./agents.ts";
import { runs } from "./runs.ts";
import { sessions } from "./sessions.ts";
import { workspaces } from "./workspaces.ts";

/**
 * A workspace's own Anthropic API key (M8.1), encrypted with `SECRETS_KEY`.
 * Write-only: the UI sees `key_hint`, the last four characters. Every
 * Anthropic-side id below belongs to the key that made it, so setting or
 * removing the key clears them.
 */
export const workspaceAnthropicKeys = sqliteTable("workspace_anthropic_keys", {
  apiKeyEnc: text("api_key_enc").notNull(),
  createdAt: createdAt(),
  // The workspace's one Managed Agents environment, created on first use.
  environmentId: text("environment_id"),
  keyHint: text("key_hint").notNull(),
  // Clerk user who set the key. Audit only.
  setBy: text("set_by").notNull(),
  updatedAt: text("updated_at").notNull(),
  workspaceId: workspaceId()
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
});

/** The Anthropic agent registered for a `managed` agent, and what it was registered with. */
export const managedAgents = sqliteTable("managed_agents", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id),
  anthropicAgentId: text("anthropic_agent_id").notNull(),
  createdAt: createdAt(),
  // Hash of the model, instructions and MCP servers the Anthropic agent has.
  // A session made under another fingerprint is not reused.
  fingerprint: text("fingerprint").notNull(),
  syncedAt: text("synced_at").notNull(),
  workspaceId: workspaceId().references(() => workspaces.id),
});

/**
 * One version of a central skill (SK.2) uploaded to Anthropic's Skills API,
 * keyed on the Agentum skill id and version number. A version is
 * uploaded once and reused by every agent that carries it. The versions of one
 * skill go under one Anthropic skill, so its rows share `anthropic_skill_id`.
 * Two launches racing to upload different first versions can leave two.
 */
export const managedSkillVersions = sqliteTable(
  "managed_skill_versions",
  {
    anthropicSkillId: text("anthropic_skill_id").notNull(),
    anthropicVersion: text("anthropic_version").notNull(),
    createdAt: createdAt(),
    // The Agentum skill id.
    skillId: text("skill_id").notNull(),
    // The Agentum version number.
    version: integer("version").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [primaryKey({ columns: [t.skillId, t.version] })]
);

/**
 * The per-agent mirrors the library skills had before SK.2: one Anthropic skill
 * per agent and skill folder. Nothing writes it any more. A launch deletes the
 * agent's rows and their Anthropic skills, and the table can go with the next
 * release.
 */
export const managedSkills = sqliteTable(
  "managed_skills",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    anthropicSkillId: text("anthropic_skill_id").notNull(),
    anthropicVersion: text("anthropic_version").notNull(),
    // Hash of the skill's files.
    contentHash: text("content_hash").notNull(),
    createdAt: createdAt(),
    // The skill folder name.
    name: text("name").notNull(),
    syncedAt: text("synced_at").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.name] })]
);

/**
 * The Anthropic session behind a Agentum session, with the vault that
 * holds its session token. `cursor_*` is how far its events have been read.
 * A session that ended any way but a clean turn is closed and never reused.
 */
export const managedSessions = sqliteTable("managed_sessions", {
  agentFingerprint: text("agent_fingerprint").notNull(),
  // Null until the Anthropic session exists. The row is written first so the
  // session token works from the session's first tool call.
  anthropicSessionId: text("anthropic_session_id"),
  closedAt: text("closed_at"),
  createdAt: createdAt(),
  // The run this session is serving. Its session token acts as this run and
  // no other, and the id is set before the run's first message is sent.
  currentRunId: text("current_run_id"),
  cursorEventId: text("cursor_event_id"),
  cursorProcessedAt: text("cursor_processed_at"),
  sessionId: text("session_id")
    .primaryKey()
    .references(() => sessions.id),
  // Epoch milliseconds in the session token. A newer session replaces it.
  tokenIssuedAt: integer("token_issued_at").notNull(),
  vaultId: text("vault_id").notNull(),
  workspaceId: workspaceId().references(() => workspaces.id),
});

/** Where one managed run is in its Anthropic session. */
export const managedRuns = sqliteTable("managed_runs", {
  createdAt: createdAt(),
  // Polls that failed in a row. Too many fail the run.
  failures: integer("failures").notNull().default(0),
  // The seq of the next event stored for the run. Re-sent events keep their seq.
  nextSeq: integer("next_seq").notNull().default(1),
  runId: text("run_id")
    .primaryKey()
    .references(() => runs.id),
  // When the message reached the Anthropic session. Null until it did.
  sentAt: text("sent_at"),
  workspaceId: workspaceId().references(() => workspaces.id),
});
