CREATE TABLE `guest_comment_effects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text NOT NULL,
	`call_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`thread_id` text NOT NULL,
	`comment_id` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_id`) REFERENCES `artifact_comment_threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`comment_id`) REFERENCES `artifact_comments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_comment_effect_run_call` ON `guest_comment_effects` (`run_id`,`call_id`);--> statement-breakpoint
CREATE TABLE `guest_comment_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`comment_id` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_id`) REFERENCES `artifact_comment_threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`comment_id`) REFERENCES `artifact_comments`(`id`) ON UPDATE no action ON DELETE no action
);
