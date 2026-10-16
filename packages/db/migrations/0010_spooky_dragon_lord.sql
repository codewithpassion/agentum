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
ALTER TABLE `runs` ADD `pending_attempts` integer DEFAULT 0 NOT NULL;