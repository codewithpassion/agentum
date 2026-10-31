CREATE TABLE `a2a_answer_markers` (
	`connection_id` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`request_id` text NOT NULL,
	`task_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `a2a_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `a2a_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `a2a_answer_markers_connection_message_unique` ON `a2a_answer_markers` (`connection_id`,`message_id`);--> statement-breakpoint
ALTER TABLE `a2a_tasks` ADD `move_token` text;--> statement-breakpoint
ALTER TABLE `a2a_tasks` ADD `swept_at` text;--> statement-breakpoint
CREATE INDEX `a2a_tasks_run_id_idx` ON `a2a_tasks` (`run_id`);--> statement-breakpoint
CREATE INDEX `a2a_tasks_state_swept_idx` ON `a2a_tasks` (`state`,`swept_at`);