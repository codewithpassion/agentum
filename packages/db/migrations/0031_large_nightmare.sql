CREATE TABLE `artifact_mention_deliveries` (
	`artifact_id` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`comment_id` text NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`comment_id`) REFERENCES `artifact_comments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_mention_deliveries_recipient_unique` ON `artifact_mention_deliveries` (`comment_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `artifact_mention_deliveries_pending_idx` ON `artifact_mention_deliveries` (`completed_at`,`id`);