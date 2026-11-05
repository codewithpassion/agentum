CREATE TABLE `assistant_conversations` (
	`archived_at` text,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`updated_at` text NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assistant_conversations_owner` ON `assistant_conversations` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `assistant_messages` (
	`content` text NOT NULL,
	`conversation_id` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`seq` integer NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `assistant_conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_messages_seq` ON `assistant_messages` (`conversation_id`,`seq`);