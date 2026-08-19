CREATE TABLE `channel_bridges` (
	`agent_id` text,
	`channel_id` text NOT NULL,
	`connector` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`external_channel_id` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_bridges_channel_idx` ON `channel_bridges` (`channel_id`,`connector`);--> statement-breakpoint
CREATE UNIQUE INDEX `channel_bridges_external_idx` ON `channel_bridges` (`connector`,`external_channel_id`);--> statement-breakpoint
CREATE TABLE `slack_events_seen` (
	`event_id` text PRIMARY KEY NOT NULL,
	`seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `slack_users` (
	`display_name` text NOT NULL,
	`fetched_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`user_id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE INDEX `external_refs_internal_idx` ON `external_refs` (`connector`,`internal_type`,`internal_id`);