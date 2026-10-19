CREATE TABLE `slack_messages` (
	`app_id` text NOT NULL,
	`batched_at` text,
	`channel_id` text NOT NULL,
	`clerk_user_id` text,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`slack_user_id` text NOT NULL,
	`text` text NOT NULL,
	`thread_ts` text,
	`ts` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `slack_apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slack_messages_message_unique` ON `slack_messages` (`app_id`,`channel_id`,`ts`);--> statement-breakpoint
CREATE INDEX `slack_messages_created_idx` ON `slack_messages` (`created_at`);--> statement-breakpoint
CREATE INDEX `slack_messages_batch_idx` ON `slack_messages` (`batched_at`,`created_at`);--> statement-breakpoint
ALTER TABLE `slack_apps` ADD `listen_mode` text DEFAULT 'mentions' NOT NULL;