CREATE TABLE `agents` (
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
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_slug_unique` ON `agents` (`workspace_id`,`slug`);--> statement-breakpoint
CREATE TABLE `events` (
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
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_session_idx` ON `events` (`session_id`,`id`);--> statement-breakpoint
CREATE INDEX `events_run_idx` ON `events` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_workspace_created_idx` ON `events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `files` (
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
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `machine_enroll_tokens` (
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`machine_name` text NOT NULL,
	`token_hash` text NOT NULL,
	`used_at` text,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_enroll_tokens_hash_unique` ON `machine_enroll_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `machines` (
	`capabilities` text NOT NULL,
	`created_at` text NOT NULL,
	`credential_hash` text NOT NULL,
	`enrolled_by` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_seen_at` text,
	`name` text NOT NULL,
	`single_user` integer NOT NULL,
	`status` text NOT NULL,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
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
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_request_unique` ON `runs` (`workspace_id`,`request_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
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
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_key_unique` ON `sessions` (`workspace_id`,`agent_id`,`origin`,`external_key`);--> statement-breakpoint
CREATE TABLE `identity_links` (
	`clerk_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`email` text NOT NULL,
	`external_user_id` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`team_id` text NOT NULL,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_links_identity_unique` ON `identity_links` (`workspace_id`,`provider`,`team_id`,`external_user_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`clerk_org_id` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`timezone` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_clerk_org_id_unique` ON `workspaces` (`clerk_org_id`);
--> statement-breakpoint
-- Hand-written: drizzle-kit does not emit triggers. events is append-only.
CREATE TRIGGER `events_no_update` BEFORE UPDATE ON `events`
BEGIN
	SELECT RAISE(ABORT, 'events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `events_no_delete` BEFORE DELETE ON `events`
BEGIN
	SELECT RAISE(ABORT, 'events is append-only');
END;
