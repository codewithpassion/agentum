CREATE TABLE `computer_enrollments` (
	`code_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`host_id` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`redeemed_at` integer,
	`redeemed_credential_hash` text,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `computer_enrollments_code_hash_unique` ON `computer_enrollments` (`code_hash`);--> statement-breakpoint
ALTER TABLE `computer_hosts` ADD `arch` text;--> statement-breakpoint
ALTER TABLE `computer_hosts` ADD `capabilities` text;--> statement-breakpoint
ALTER TABLE `computer_hosts` ADD `os` text;--> statement-breakpoint
ALTER TABLE `computer_hosts` ADD `protocol_version` integer;