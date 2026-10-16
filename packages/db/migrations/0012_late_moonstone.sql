-- Hand-edited: a routine has no token, so token_hash and token_prefix become
-- nullable, which SQLite only does by rebuilding the table. Nothing references
-- triggers, so no PRAGMA is needed (D1 cannot switch foreign_keys off). The
-- copy lists only the old columns; drizzle-kit listed the new ones too.
CREATE TABLE `__new_triggers` (
	`agent_id` text NOT NULL,
	`consecutive_errors` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`cron` text,
	`disabled_at` text,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`last_error` text,
	`last_fired_at` text,
	`name` text NOT NULL,
	`next_run_at` text,
	`prompt` text,
	`revoked_at` text,
	`settled_run_id` text,
	`timezone` text,
	`token_hash` text,
	`token_prefix` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_triggers`("agent_id", "created_at", "created_by", "id", "kind", "last_fired_at", "name", "revoked_at", "token_hash", "token_prefix", "workspace_id") SELECT "agent_id", "created_at", "created_by", "id", "kind", "last_fired_at", "name", "revoked_at", "token_hash", "token_prefix", "workspace_id" FROM `triggers`;--> statement-breakpoint
DROP TABLE `triggers`;--> statement-breakpoint
ALTER TABLE `__new_triggers` RENAME TO `triggers`;--> statement-breakpoint
CREATE UNIQUE INDEX `triggers_token_hash_unique` ON `triggers` (`token_hash`);--> statement-breakpoint
CREATE INDEX `triggers_due_idx` ON `triggers` (`next_run_at`);--> statement-breakpoint
CREATE INDEX `runs_actor_idx` ON `runs` (`actor_id`,`id`);