CREATE TABLE `a2a_agent_cards` (
	`agent_id` text NOT NULL,
	`description` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`pairing_failures` integer DEFAULT 0 NOT NULL,
	`pairing_locked_until` text,
	`pairing_open` integer DEFAULT false NOT NULL,
	`public_id` text NOT NULL,
	`published_at` text NOT NULL,
	`published_by` text NOT NULL,
	`skills` text NOT NULL,
	`unpublished_at` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `a2a_agent_cards_agent_id_unique` ON `a2a_agent_cards` (`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `a2a_agent_cards_public_id_unique` ON `a2a_agent_cards` (`public_id`);--> statement-breakpoint
CREATE TABLE `a2a_connections` (
	`approved_at` text,
	`approved_by` text,
	`check_code` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`hourly_limit` integer DEFAULT 20 NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`inbound_policy` text DEFAULT 'approve' NOT NULL,
	`inbound_token_hash` text,
	`inbound_token_prefix` text,
	`invite_expires_at` text,
	`invite_failures` integer DEFAULT 0 NOT NULL,
	`invite_token_hash` text,
	`last_in_at` text,
	`last_out_at` text,
	`local_agent_id` text NOT NULL,
	`outbound_credential` text,
	`outbound_policy` text DEFAULT 'approve' NOT NULL,
	`outbound_scheme` text,
	`peer_card` text,
	`peer_card_fetched_at` text,
	`peer_card_url` text,
	`peer_kind` text NOT NULL,
	`peer_label` text,
	`peer_org` text,
	`peer_origin` text,
	`revoked_at` text,
	`revoked_by` text,
	`slug` text NOT NULL,
	`status` text NOT NULL,
	`tool_policy` text DEFAULT 'ask' NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`local_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `a2a_connections_inbound_token_unique` ON `a2a_connections` (`inbound_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `a2a_connections_invite_token_unique` ON `a2a_connections` (`invite_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `a2a_connections_slug_unique` ON `a2a_connections` (`workspace_id`,`slug`);--> statement-breakpoint
CREATE TABLE `a2a_outbound_tasks` (
	`calling_run_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`context_id` text,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`next_poll_at` text,
	`poll_until` text,
	`remote_task_id` text,
	`request_id` text,
	`result_read_at` text,
	`result_text` text,
	`session_id` text NOT NULL,
	`state` text DEFAULT 'TASK_STATE_SUBMITTED' NOT NULL,
	`text` text NOT NULL,
	`updated_at` text NOT NULL,
	`webhook_token_hash` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`calling_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `a2a_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `a2a_outbound_tasks_next_poll_idx` ON `a2a_outbound_tasks` (`next_poll_at`);--> statement-breakpoint
CREATE TABLE `a2a_outbox` (
	`attempts` integer DEFAULT 0 NOT NULL,
	`body` text NOT NULL,
	`connection_id` text NOT NULL,
	`created_at` text NOT NULL,
	`headers` text,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`next_attempt_at` text NOT NULL,
	`url` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `a2a_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `a2a_outbox_next_attempt_idx` ON `a2a_outbox` (`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `a2a_pairing_requests` (
	`agent_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `a2a_pairing_requests_agent_token_unique` ON `a2a_pairing_requests` (`agent_id`,`token_hash`);--> statement-breakpoint
CREATE TABLE `a2a_push_configs` (
	`authentication` text,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`token` text,
	`url` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `a2a_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `a2a_tasks` (
	`connection_id` text NOT NULL,
	`context_id` text NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text,
	`decided_by` text,
	`hops` integer DEFAULT 0 NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`input_text` text NOT NULL,
	`message_id` text NOT NULL,
	`result_text` text,
	`run_id` text,
	`state` text DEFAULT 'TASK_STATE_SUBMITTED' NOT NULL,
	`status_text` text,
	`updated_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `a2a_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `a2a_tasks_connection_message_unique` ON `a2a_tasks` (`connection_id`,`message_id`);