-- drizzle-kit recreates each table to add its foreign keys, and emits the
-- tables alphabetically. D1 cannot turn foreign_keys off inside a migration,
-- so the blocks are reordered by hand, parents first: a table is dropped only
-- while no rebuilt table references it yet, which keeps the implicit DELETE of
-- DROP TABLE from tripping a constraint when the tables hold rows. The
-- PRAGMA foreign_keys lines drizzle-kit emitted are dropped for the same reason.
-- A runs row with parent_run_id set would still fail the DROP of runs, which
-- is fine only because the tables are empty (M0.11 runs before any writer).
CREATE TABLE `__new_machines` (
	`capabilities` text NOT NULL,
	`created_at` text NOT NULL,
	`credential_hash` text NOT NULL,
	`enrolled_by` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_seen_at` text,
	`name` text NOT NULL,
	`single_user` integer NOT NULL,
	`status` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_machines`("capabilities", "created_at", "credential_hash", "enrolled_by", "id", "last_seen_at", "name", "single_user", "status", "workspace_id") SELECT "capabilities", "created_at", "credential_hash", "enrolled_by", "id", "last_seen_at", "name", "single_user", "status", "workspace_id" FROM `machines`;--> statement-breakpoint
DROP TABLE `machines`;--> statement-breakpoint
ALTER TABLE `__new_machines` RENAME TO `machines`;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`instructions` text NOT NULL,
	`machine_id` text,
	`model` text NOT NULL,
	`name` text NOT NULL,
	`runtime` text NOT NULL,
	`runtime_config` text NOT NULL,
	`slug` text NOT NULL,
	`status` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_agents`("created_at", "created_by", "id", "instructions", "machine_id", "model", "name", "runtime", "runtime_config", "slug", "status", "workspace_id") SELECT "created_at", "created_by", "id", "instructions", "machine_id", "model", "name", "runtime", "runtime_config", "slug", "status", "workspace_id" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_slug_unique` ON `agents` (`workspace_id`,`slug`);--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`actor_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	`external_key` text,
	`id` text PRIMARY KEY NOT NULL,
	`last_run_at` text,
	`origin` text NOT NULL,
	`runtime_machine_id` text,
	`runtime_ref` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`runtime_machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("actor_id", "actor_kind", "agent_id", "created_at", "external_key", "id", "last_run_at", "origin", "runtime_machine_id", "runtime_ref", "workspace_id") SELECT "actor_id", "actor_kind", "agent_id", "created_at", "external_key", "id", "last_run_at", "origin", "runtime_machine_id", "runtime_ref", "workspace_id" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_key_unique` ON `sessions` (`workspace_id`,`agent_id`,`origin`,`external_key`);--> statement-breakpoint
CREATE TABLE `__new_runs` (
	`actor_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`agent_id` text NOT NULL,
	`claimed_by` text,
	`created_at` text NOT NULL,
	`depth` integer DEFAULT 0 NOT NULL,
	`error` text,
	`finished_at` text,
	`id` text PRIMARY KEY NOT NULL,
	`input_file_ids` text DEFAULT '[]' NOT NULL,
	`input_text` text NOT NULL,
	`lease_until` text,
	`on_behalf_of_user_id` text,
	`output_file_ids` text DEFAULT '[]' NOT NULL,
	`parent_run_id` text,
	`pending_files` text,
	`process_ended_at` text,
	`reply` text,
	`request_id` text,
	`result_text` text,
	`session_id` text NOT NULL,
	`started_at` text,
	`status` text NOT NULL,
	`usage` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_runs`("actor_id", "actor_kind", "agent_id", "claimed_by", "created_at", "depth", "error", "finished_at", "id", "input_file_ids", "input_text", "lease_until", "on_behalf_of_user_id", "output_file_ids", "parent_run_id", "pending_files", "process_ended_at", "reply", "request_id", "result_text", "session_id", "started_at", "status", "usage", "workspace_id") SELECT "actor_id", "actor_kind", "agent_id", "claimed_by", "created_at", "depth", "error", "finished_at", "id", "input_file_ids", "input_text", "lease_until", "on_behalf_of_user_id", "output_file_ids", "parent_run_id", "pending_files", "process_ended_at", "reply", "request_id", "result_text", "session_id", "started_at", "status", "usage", "workspace_id" FROM `runs`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
CREATE UNIQUE INDEX `runs_request_unique` ON `runs` (`workspace_id`,`request_id`);--> statement-breakpoint
CREATE TABLE `__new_events` (
	`actor_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`agent_id` text,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`payload` text,
	`payload_ref` text,
	`run_id` text,
	`seq` integer,
	`session_id` text,
	`type` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_events`("actor_id", "actor_kind", "agent_id", "created_at", "id", "payload", "payload_ref", "run_id", "seq", "session_id", "type", "workspace_id") SELECT "actor_id", "actor_kind", "agent_id", "created_at", "id", "payload", "payload_ref", "run_id", "seq", "session_id", "type", "workspace_id" FROM `events`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
CREATE INDEX `events_session_idx` ON `events` (`session_id`,`id`);--> statement-breakpoint
CREATE INDEX `events_run_idx` ON `events` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_workspace_created_idx` ON `events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_files` (
	`created_at` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_by_kind` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`mime` text NOT NULL,
	`name` text NOT NULL,
	`r2_key` text NOT NULL,
	`run_id` text,
	`size` integer NOT NULL,
	`source` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_files`("created_at", "created_by_id", "created_by_kind", "id", "mime", "name", "r2_key", "run_id", "size", "source", "workspace_id") SELECT "created_at", "created_by_id", "created_by_kind", "id", "mime", "name", "r2_key", "run_id", "size", "source", "workspace_id" FROM `files`;--> statement-breakpoint
DROP TABLE `files`;--> statement-breakpoint
ALTER TABLE `__new_files` RENAME TO `files`;--> statement-breakpoint
CREATE TABLE `__new_triggers` (
	`agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_triggers`("agent_id", "created_at", "id", "token_hash", "workspace_id") SELECT "agent_id", "created_at", "id", "token_hash", "workspace_id" FROM `triggers`;--> statement-breakpoint
DROP TABLE `triggers`;--> statement-breakpoint
ALTER TABLE `__new_triggers` RENAME TO `triggers`;--> statement-breakpoint
CREATE UNIQUE INDEX `triggers_token_hash_unique` ON `triggers` (`token_hash`);--> statement-breakpoint
CREATE TABLE `__new_api_keys` (
	`access` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`key_hash` text NOT NULL,
	`last_used_at` text,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`revoked_at` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_api_keys`("access", "created_at", "created_by", "id", "key_hash", "last_used_at", "name", "prefix", "revoked_at", "workspace_id") SELECT "access", "created_at", "created_by", "id", "key_hash", "last_used_at", "name", "prefix", "revoked_at", "workspace_id" FROM `api_keys`;--> statement-breakpoint
DROP TABLE `api_keys`;--> statement-breakpoint
ALTER TABLE `__new_api_keys` RENAME TO `api_keys`;--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `__new_machine_enroll_tokens` (
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`machine_name` text NOT NULL,
	`token_hash` text NOT NULL,
	`used_at` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_machine_enroll_tokens`("created_at", "expires_at", "id", "machine_name", "token_hash", "used_at", "workspace_id") SELECT "created_at", "expires_at", "id", "machine_name", "token_hash", "used_at", "workspace_id" FROM `machine_enroll_tokens`;--> statement-breakpoint
DROP TABLE `machine_enroll_tokens`;--> statement-breakpoint
ALTER TABLE `__new_machine_enroll_tokens` RENAME TO `machine_enroll_tokens`;--> statement-breakpoint
CREATE UNIQUE INDEX `machine_enroll_tokens_hash_unique` ON `machine_enroll_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `__new_identity_links` (
	`clerk_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`email` text NOT NULL,
	`external_user_id` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`team_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_identity_links`("clerk_user_id", "created_at", "email", "external_user_id", "id", "provider", "team_id", "workspace_id") SELECT "clerk_user_id", "created_at", "email", "external_user_id", "id", "provider", "team_id", "workspace_id" FROM `identity_links`;--> statement-breakpoint
DROP TABLE `identity_links`;--> statement-breakpoint
ALTER TABLE `__new_identity_links` RENAME TO `identity_links`;--> statement-breakpoint
CREATE UNIQUE INDEX `identity_links_identity_unique` ON `identity_links` (`workspace_id`,`provider`,`team_id`,`external_user_id`);
--> statement-breakpoint
-- Hand-written: drizzle-kit does not emit triggers, and recreating events above
-- dropped the ones from 0002_foundation. events is append-only.
CREATE TRIGGER `events_no_update` BEFORE UPDATE ON `events`
BEGIN
	SELECT RAISE(ABORT, 'events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `events_no_delete` BEFORE DELETE ON `events`
BEGIN
	SELECT RAISE(ABORT, 'events is append-only');
END;
