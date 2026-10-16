CREATE TABLE `oauth_clients` (
	`access` text,
	`approved_at` text,
	`client_id` text NOT NULL,
	`created_at` text NOT NULL,
	`first_seen_by` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_used_at` text,
	`name` text,
	`revoked_at` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_clients_client_id_unique` ON `oauth_clients` (`client_id`);