CREATE TABLE `guest_run_scopes` (
	`workspace_id` text NOT NULL,
	`member_id` text NOT NULL,
	`run_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `artifact_members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `runs_guest_daily_idx` ON `runs` (`workspace_id`,`actor_kind`,`actor_id`,`created_at`);