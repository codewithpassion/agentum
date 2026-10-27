CREATE TABLE `artifact_ask_dispatches` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`comment_id` text NOT NULL,
	`request_id` text NOT NULL,
	`author_id` text NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	`run_id` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`comment_id`) REFERENCES `artifact_comments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_ask_dispatches_comment_id_unique` ON `artifact_ask_dispatches` (`comment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_ask_dispatches_request_unique` ON `artifact_ask_dispatches` (`workspace_id`,`author_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `artifact_ask_dispatches_pending_idx` ON `artifact_ask_dispatches` (`completed_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_artifact_unique` ON `sessions` (`workspace_id`,`external_key`) WHERE "sessions"."origin" = 'artifact';