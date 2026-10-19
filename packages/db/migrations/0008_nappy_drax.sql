CREATE TABLE `slack_threads` (
	`agent_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`team_id` text NOT NULL,
	`thread_ts` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slack_threads_thread_unique` ON `slack_threads` (`agent_id`,`team_id`,`channel_id`,`thread_ts`);