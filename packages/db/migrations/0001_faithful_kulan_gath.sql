CREATE TABLE `managed_agents` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`anthropic_agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	`fingerprint` text NOT NULL,
	`synced_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `managed_runs` (
	`created_at` text NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`next_seq` integer DEFAULT 1 NOT NULL,
	`run_id` text PRIMARY KEY NOT NULL,
	`sent_at` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `managed_sessions` (
	`agent_fingerprint` text NOT NULL,
	`anthropic_session_id` text,
	`closed_at` text,
	`created_at` text NOT NULL,
	`current_run_id` text,
	`cursor_event_id` text,
	`cursor_processed_at` text,
	`session_id` text PRIMARY KEY NOT NULL,
	`token_issued_at` integer NOT NULL,
	`vault_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workspace_anthropic_keys` (
	`api_key_enc` text NOT NULL,
	`created_at` text NOT NULL,
	`environment_id` text,
	`key_hint` text NOT NULL,
	`set_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`workspace_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
