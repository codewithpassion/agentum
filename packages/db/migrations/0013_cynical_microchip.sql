CREATE TABLE `run_requests` (
	`answer` text,
	`answered_at` text,
	`answered_by` text,
	`answered_via` text,
	`agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	`delivered_at` text,
	`display` text NOT NULL,
	`expires_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`run_id` text NOT NULL,
	`session_id` text NOT NULL,
	`slack_message` text,
	`status` text NOT NULL,
	`tool_name` text NOT NULL,
	`tool_key` text,
	`tool_use_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_requests_tool_use_unique` ON `run_requests` (`run_id`,`tool_use_id`);--> statement-breakpoint
CREATE INDEX `run_requests_workspace_status_idx` ON `run_requests` (`workspace_id`,`status`);--> statement-breakpoint
CREATE INDEX `run_requests_status_expires_idx` ON `run_requests` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `agent_tool_rules` (
	`agent_id` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`tool_key` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tool_rules_unique` ON `agent_tool_rules` (`agent_id`,`tool_key`);