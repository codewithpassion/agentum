-- Hand-edited: SQLite cannot add NOT NULL columns without a default, so the
-- M0.1 stub is replaced. Nothing could mint a trigger token before M4.1, so
-- the stub holds no rows worth keeping, and no table references triggers.
DROP TABLE `triggers`;--> statement-breakpoint
CREATE TABLE `triggers` (
	`agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`last_fired_at` text,
	`name` text NOT NULL,
	`revoked_at` text,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `triggers_token_hash_unique` ON `triggers` (`token_hash`);
