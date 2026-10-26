CREATE TABLE `map_positions` (
	`node_key` text NOT NULL,
	`updated_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	PRIMARY KEY(`workspace_id`, `node_key`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `qa_answers` (
	`author_id` text NOT NULL,
	`author_kind` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`run_id` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `qa_questions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `qa_answers_question_idx` ON `qa_answers` (`question_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `qa_questions` (
	`accepted_answer_id` text,
	`author_id` text NOT NULL,
	`author_kind` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`updated_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `qa_questions_status_idx` ON `qa_questions` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `skill_sources` (
	`checked_at` text,
	`commit_sha` text NOT NULL,
	`created_at` text NOT NULL,
	`latest_commit_sha` text,
	`path` text,
	`provider` text NOT NULL,
	`ref` text NOT NULL,
	`repo_url` text NOT NULL,
	`skill_id` text PRIMARY KEY NOT NULL,
	`updated_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `skill_sources_checked_idx` ON `skill_sources` (`checked_at`);--> statement-breakpoint
ALTER TABLE `skill_versions` ADD `source_commit_sha` text;--> statement-breakpoint
CREATE INDEX `events_workspace_type_created_idx` ON `events` (`workspace_id`,`type`,`created_at`);