CREATE TABLE `inbox_posts` (
	`author_id` text NOT NULL,
	`author_kind` text NOT NULL,
	`created_at` text NOT NULL,
	`file_ids` text DEFAULT '[]' NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`text` text NOT NULL,
	`thread_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_id`) REFERENCES `inbox_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inbox_posts_thread_idx` ON `inbox_posts` (`thread_id`,`id`);--> statement-breakpoint
CREATE TABLE `inbox_threads` (
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_post_at` text NOT NULL,
	`title` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inbox_threads_recent_idx` ON `inbox_threads` (`workspace_id`,`last_post_at`);