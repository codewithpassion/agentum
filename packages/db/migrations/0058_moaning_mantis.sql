CREATE TABLE `dream_runs` (
	`agent_id` text NOT NULL,
	`base_version` text DEFAULT '[]' NOT NULL,
	`counts` text DEFAULT '{"added":0,"dropped":0,"merged":0,"questions":0}' NOT NULL,
	`diary` text DEFAULT '' NOT NULL,
	`error` text,
	`finished_at` text,
	`id` text PRIMARY KEY NOT NULL,
	`result_version` text,
	`since` text,
	`started_at` text NOT NULL,
	`status` text NOT NULL,
	`usage` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dream_runs_agent_idx` ON `dream_runs` (`workspace_id`,`agent_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `triggers_dream_agent_unique` ON `triggers` (`agent_id`) WHERE "triggers"."kind" = 'dream' and "triggers"."revoked_at" is null;