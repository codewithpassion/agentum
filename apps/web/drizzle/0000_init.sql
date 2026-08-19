CREATE TABLE `agents` (
	`anthropic_agent_id` text,
	`avatar` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`mcp_token` text,
	`memory_store_id` text,
	`name` text NOT NULL,
	`soul` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_name_unique` ON `agents` (`name`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`filename` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`mime` text NOT NULL,
	`r2_key` text NOT NULL,
	`size` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_message_idx` ON `attachments` (`message_id`);--> statement-breakpoint
CREATE TABLE `channel_members` (
	`channel_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`member_id` text NOT NULL,
	`member_type` text NOT NULL,
	PRIMARY KEY(`channel_id`, `member_type`, `member_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'channel' NOT NULL,
	`name` text NOT NULL,
	`origin` text DEFAULT 'native' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message_mentions` (
	`agent_id` text NOT NULL,
	`message_id` text NOT NULL,
	PRIMARY KEY(`message_id`, `agent_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`author_id` text NOT NULL,
	`author_type` text NOT NULL,
	`body` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`origin` text DEFAULT 'native' NOT NULL,
	`thread_parent_id` text,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_channel_created_idx` ON `messages` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `messages_thread_parent_idx` ON `messages` (`thread_parent_id`);--> statement-breakpoint
CREATE TABLE `external_refs` (
	`connector` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`external_id` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`internal_id` text NOT NULL,
	`internal_type` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_refs_connector_external_idx` ON `external_refs` (`connector`,`internal_type`,`external_id`);