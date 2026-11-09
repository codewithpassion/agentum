ALTER TABLE `agents` ADD `subagents` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `access_scope` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `model` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `subagent_level` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `runs_parent_idx` ON `runs` (`parent_run_id`);