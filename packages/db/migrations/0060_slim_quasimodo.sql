CREATE TABLE `discussions` (
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`rounds` integer NOT NULL,
	`started_by_agent_id` text NOT NULL,
	`status` text NOT NULL,
	`thread_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`started_by_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_id`) REFERENCES `inbox_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `discussions_thread_idx` ON `discussions` (`thread_id`,`status`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__old_dream_questions` AS SELECT * FROM `dream_questions`;--> statement-breakpoint
DROP TABLE `dream_questions`;--> statement-breakpoint
CREATE TABLE `__new_dream_runs` (
	`agent_id` text,
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
	`team_id` text,
	`usage` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_dream_runs`("agent_id", "base_version", "counts", "diary", "error", "finished_at", "id", "result_version", "since", "started_at", "status", "team_id", "usage", "workspace_id") SELECT "agent_id", "base_version", "counts", "diary", "error", "finished_at", "id", "result_version", "since", "started_at", "status", NULL, "usage", "workspace_id" FROM `dream_runs`;--> statement-breakpoint
DROP TABLE `dream_runs`;--> statement-breakpoint
ALTER TABLE `__new_dream_runs` RENAME TO `dream_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `dream_questions` (
	`agent_id` text NOT NULL,
	`answered_at` text,
	`answered_by` text,
	`answered_note_id` text,
	`created_at` text NOT NULL,
	`dream_run_id` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`options` text NOT NULL,
	`question` text NOT NULL,
	`status` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dream_run_id`) REFERENCES `dream_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `dream_questions`(`agent_id`, `answered_at`, `answered_by`, `answered_note_id`, `created_at`, `dream_run_id`, `id`, `options`, `question`, `status`, `workspace_id`) SELECT `agent_id`, `answered_at`, `answered_by`, `answered_note_id`, `created_at`, `dream_run_id`, `id`, `options`, `question`, `status`, `workspace_id` FROM `__old_dream_questions`;--> statement-breakpoint
DROP TABLE `__old_dream_questions`;--> statement-breakpoint
CREATE INDEX `dream_questions_status_idx` ON `dream_questions` (`workspace_id`,`status`);--> statement-breakpoint
CREATE INDEX `dream_questions_run_idx` ON `dream_questions` (`dream_run_id`);--> statement-breakpoint
CREATE INDEX `dream_runs_agent_idx` ON `dream_runs` (`workspace_id`,`agent_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `dream_runs_team_idx` ON `dream_runs` (`workspace_id`,`team_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `__new_memory_changes` (
	`action` text NOT NULL,
	`agent_id` text,
	`created_at` text NOT NULL,
	`decided_at` text,
	`decided_by` text,
	`dream_run_id` text,
	`group_id` text,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`library_version_id` text,
	`note_id` text NOT NULL,
	`source_id` text,
	`source_kind` text,
	`status` text NOT NULL,
	`team_id` text,
	`text` text NOT NULL,
	`user_scope` text,
	`workspace_id` text NOT NULL,
	`written_by` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`library_version_id`) REFERENCES `library_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_memory_changes`("action", "agent_id", "created_at", "decided_at", "decided_by", "dream_run_id", "group_id", "id", "kind", "library_version_id", "note_id", "source_id", "source_kind", "status", "team_id", "text", "user_scope", "workspace_id", "written_by") SELECT "action", "agent_id", "created_at", "decided_at", "decided_by", "dream_run_id", "group_id", "id", "kind", "library_version_id", "note_id", "source_id", "source_kind", "status", NULL, "text", "user_scope", "workspace_id", "written_by" FROM `memory_changes`;--> statement-breakpoint
DROP TABLE `memory_changes`;--> statement-breakpoint
ALTER TABLE `__new_memory_changes` RENAME TO `memory_changes`;--> statement-breakpoint
CREATE INDEX `memory_changes_agent_idx` ON `memory_changes` (`workspace_id`,`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `memory_changes_status_idx` ON `memory_changes` (`workspace_id`,`status`);--> statement-breakpoint
CREATE INDEX `memory_changes_note_idx` ON `memory_changes` (`workspace_id`,`note_id`);--> statement-breakpoint
CREATE INDEX `memory_changes_team_idx` ON `memory_changes` (`workspace_id`,`team_id`,`created_at`);