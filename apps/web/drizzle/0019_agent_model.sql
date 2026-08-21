-- Model configuration (docs/plan-model-config.md): which model an agent runs
-- on, and where that can be overridden. Both new columns are nullable, so every
-- existing row keeps meaning "the default" - `agents.model` null is the
-- workspace default, `routines.model` null is the agent's own model.
CREATE TABLE `agent_model_overrides` (
	`agent_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_by` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`thread_parent_id` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_model_overrides_workspace_idx` ON `agent_model_overrides` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_model_overrides_scope_idx` ON `agent_model_overrides` (`agent_id`,`channel_id`,`thread_parent_id`);--> statement-breakpoint
ALTER TABLE `agents` ADD `model` text;--> statement-breakpoint
ALTER TABLE `routines` ADD `model` text;