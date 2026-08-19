CREATE TABLE `browser_screenshots` (
	`agent_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`page_url` text NOT NULL,
	`r2_key` text NOT NULL,
	`size` integer NOT NULL,
	`title` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `browser_screenshots_agent_created_idx` ON `browser_screenshots` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `browser_sessions` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`current_url` text,
	`session_id` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
