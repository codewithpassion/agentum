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
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_slug_unique` ON `agents` (`workspace_id`,`slug`);--> statement-breakpoint
CREATE TABLE `api_keys` (
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
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `agent_connectors` (
	`agent_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`created_at` text NOT NULL,
	`credential_mode` text DEFAULT 'user_or_agent' NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`agent_id`, `connector_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connector_id`) REFERENCES `connectors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `connectors` (
	`auth_kind` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`header_name` text,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`oauth` text,
	`status` text NOT NULL,
	`tools` text DEFAULT '[]' NOT NULL,
	`tools_fetched_at` text,
	`url` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `connectors_workspace_idx` ON `connectors` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`connector_id` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` text,
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`owner_kind` text NOT NULL,
	`refreshing_until` text,
	`scopes` text,
	`secret` text NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`connector_id`) REFERENCES `connectors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_owner_unique` ON `credentials` (`connector_id`,`owner_kind`,`owner_id`);--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`connector_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`initiator_user_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`owner_kind` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`return_to` text NOT NULL,
	`state` text PRIMARY KEY NOT NULL,
	`verifier` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`connector_id`) REFERENCES `connectors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `oauth_states_expires_idx` ON `oauth_states` (`expires_at`);--> statement-breakpoint
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
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
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
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `inbox_posts` (
	`author_id` text NOT NULL,
	`author_kind` text NOT NULL,
	`created_at` text NOT NULL,
	`file_ids` text DEFAULT '[]' NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`text` text NOT NULL,
	`thread_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_id`) REFERENCES `inbox_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inbox_posts_thread_idx` ON `inbox_posts` (`thread_id`,`id`);--> statement-breakpoint
CREATE TABLE `inbox_threads` (
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_post_at` text NOT NULL,
	`title` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inbox_threads_recent_idx` ON `inbox_threads` (`workspace_id`,`last_post_at`);--> statement-breakpoint
CREATE TABLE `library_entries` (
	`etag` text,
	`kind` text NOT NULL,
	`mtime` text NOT NULL,
	`parent` text NOT NULL,
	`path` text NOT NULL,
	`size` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`updated_by_kind` text NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `path`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `library_entries_parent_idx` ON `library_entries` (`workspace_id`,`parent`);--> statement-breakpoint
CREATE TABLE `machine_enroll_tokens` (
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`machine_name` text NOT NULL,
	`token_hash` text NOT NULL,
	`used_at` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
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
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`access` text,
	`approved_at` text,
	`client_id` text NOT NULL,
	`created_at` text NOT NULL,
	`first_seen_by` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_used_at` text,
	`name` text,
	`revoked_at` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_clients_client_id_unique` ON `oauth_clients` (`client_id`);--> statement-breakpoint
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
	`pending_attempts` integer DEFAULT 0 NOT NULL,
	`pending_files` text,
	`process_ended_at` text,
	`reply` text,
	`request_id` text,
	`result_text` text,
	`session_id` text NOT NULL,
	`started_at` text,
	`status` text NOT NULL,
	`swept_at` text,
	`usage` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_request_unique` ON `runs` (`workspace_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `runs_actor_idx` ON `runs` (`actor_id`,`id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`actor_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	`external_key` text,
	`id` text PRIMARY KEY NOT NULL,
	`last_run_at` text,
	`origin` text NOT NULL,
	`private` integer DEFAULT false NOT NULL,
	`runtime_machine_id` text,
	`runtime_ref` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`runtime_machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_key_unique` ON `sessions` (`workspace_id`,`agent_id`,`origin`,`external_key`);--> statement-breakpoint
CREATE TABLE `slack_apps` (
	`agent_id` text NOT NULL,
	`app_id` text NOT NULL,
	`bot_token` text,
	`bot_user_id` text NOT NULL,
	`client_id` text,
	`client_secret` text,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`signing_secret` text NOT NULL,
	`status` text NOT NULL,
	`team_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slack_apps_app_unique` ON `slack_apps` (`app_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `slack_apps_agent_team_unique` ON `slack_apps` (`agent_id`,`team_id`);--> statement-breakpoint
CREATE TABLE `slack_events_seen` (
	`event_hash` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`received_at` text NOT NULL,
	`run_id` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slack_events_seen_hash_unique` ON `slack_events_seen` (`event_hash`);--> statement-breakpoint
CREATE INDEX `slack_events_seen_received_idx` ON `slack_events_seen` (`received_at`);--> statement-breakpoint
CREATE TABLE `triggers` (
	`agent_id` text NOT NULL,
	`consecutive_errors` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`cron` text,
	`disabled_at` text,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`last_error` text,
	`last_fired_at` text,
	`name` text NOT NULL,
	`next_run_at` text,
	`prompt` text,
	`revoked_at` text,
	`settled_run_id` text,
	`timezone` text,
	`token_hash` text,
	`token_prefix` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `triggers_token_hash_unique` ON `triggers` (`token_hash`);--> statement-breakpoint
CREATE INDEX `triggers_due_idx` ON `triggers` (`next_run_at`);--> statement-breakpoint
CREATE TABLE `identity_links` (
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
-- A migration that recreates events must add these back.
CREATE TRIGGER `events_no_update` BEFORE UPDATE ON `events`
BEGIN
	SELECT RAISE(ABORT, 'events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `events_no_delete` BEFORE DELETE ON `events`
BEGIN
	SELECT RAISE(ABORT, 'events is append-only');
END;
