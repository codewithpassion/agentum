CREATE TABLE `agent_activity` (
	`agent_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`detail` text,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_activity_agent_created_idx` ON `agent_activity` (`agent_id`,`created_at`);