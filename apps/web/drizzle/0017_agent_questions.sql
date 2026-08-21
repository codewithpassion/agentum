CREATE TABLE `agent_questions` (
	`agent_id` text NOT NULL,
	`answer` text,
	`answered_at` integer,
	`answered_by` text,
	`answered_via` text,
	`channel_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'question' NOT NULL,
	`message_id` text NOT NULL,
	`options` text,
	`prompt` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_questions_workspace_status_idx` ON `agent_questions` (`workspace_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_questions_agent_status_idx` ON `agent_questions` (`agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_questions_message_idx` ON `agent_questions` (`message_id`);