CREATE TABLE `app_config` (
	`key` text PRIMARY KEY NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `status` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `sync_error` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `sync_status` text DEFAULT 'unregistered' NOT NULL;