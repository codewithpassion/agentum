CREATE TABLE `agent_sessions` (
	`agent_id` text NOT NULL,
	`anthropic_session_id` text NOT NULL,
	`ended_at` integer,
	`end_reason` text,
	`id` text PRIMARY KEY NOT NULL,
	`model` text,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`title` text,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_sessions_anthropic_session_id_unique` ON `agent_sessions` (`anthropic_session_id`);--> statement-breakpoint
CREATE INDEX `agent_sessions_agent_idx` ON `agent_sessions` (`agent_id`,`started_at`);