CREATE TABLE `api_keys` (
	`access` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`key_hash` text NOT NULL,
	`last_used_at` text,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`revoked_at` text,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `triggers` (
	`agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `triggers_token_hash_unique` ON `triggers` (`token_hash`);