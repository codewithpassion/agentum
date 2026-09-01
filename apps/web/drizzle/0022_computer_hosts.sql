CREATE TABLE `computer_hosts` (
	`config` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`fly_api_token_enc` text,
	`fly_api_token_hint` text,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`last_seen_at` integer,
	`name` text NOT NULL,
	`status` text DEFAULT 'unconfigured' NOT NULL,
	`status_error` text,
	`token_enc` text,
	`token_hash` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `computer_hosts_token_hash_unique` ON `computer_hosts` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `computer_hosts_workspace_name_idx` ON `computer_hosts` (`workspace_id`,`name`);--> statement-breakpoint
ALTER TABLE `agents` ADD `computer` text DEFAULT 'cloudflare' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `computer_host_id` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `computer_ref` text;