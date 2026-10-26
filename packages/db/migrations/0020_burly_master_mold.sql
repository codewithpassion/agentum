CREATE TABLE `browser_sessions` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`current_url` text,
	`session_id` text NOT NULL,
	`updated_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `machine_credentials` (
	`created_at` text NOT NULL,
	`credential_hash` text NOT NULL,
	`machine_id` text NOT NULL,
	`role` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_credentials_hash_unique` ON `machine_credentials` (`credential_hash`);--> statement-breakpoint
ALTER TABLE `agents` ADD `computer_machine_id` text REFERENCES machines(id);--> statement-breakpoint
CREATE UNIQUE INDEX `agents_computer_machine_unique` ON `agents` (`computer_machine_id`) WHERE "agents"."computer_machine_id" is not null;--> statement-breakpoint
ALTER TABLE `machine_enroll_tokens` ADD `machine_id` text REFERENCES machines(id);--> statement-breakpoint
ALTER TABLE `machine_enroll_tokens` ADD `role` text DEFAULT 'agent_host' NOT NULL;--> statement-breakpoint
ALTER TABLE `machines` ADD `computer_capabilities` text;--> statement-breakpoint
ALTER TABLE `machines` ADD `computer_last_seen_at` text;--> statement-breakpoint
ALTER TABLE `machines` ADD `computer_status` text;