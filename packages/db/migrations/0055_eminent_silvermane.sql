CREATE TABLE `memory_changes` (
	`action` text NOT NULL,
	`agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text,
	`decided_by` text,
	`dream_run_id` text,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`library_version_id` text,
	`note_id` text NOT NULL,
	`source_id` text,
	`source_kind` text,
	`status` text NOT NULL,
	`text` text NOT NULL,
	`user_scope` text,
	`workspace_id` text NOT NULL,
	`written_by` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`library_version_id`) REFERENCES `library_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memory_changes_agent_idx` ON `memory_changes` (`workspace_id`,`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `memory_changes_status_idx` ON `memory_changes` (`workspace_id`,`status`);--> statement-breakpoint
CREATE INDEX `memory_changes_note_idx` ON `memory_changes` (`workspace_id`,`note_id`);--> statement-breakpoint
ALTER TABLE `agents` ADD `remember` text DEFAULT '{"dreamSchedule":"nightly","learnLevel":"tell_after","never":[],"remember":[],"shareWithTeam":true}' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `never_remember` text DEFAULT '["Passwords and keys","Card and bank numbers","Health details"]' NOT NULL;