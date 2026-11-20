CREATE TABLE `slack_room_messages` (
	`channel_id` text NOT NULL,
	`created_at` text NOT NULL,
	`direction` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`slack_team_id` text NOT NULL,
	`thread_ts` text,
	`ts` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `inbox_posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slack_room_messages_message_unique` ON `slack_room_messages` (`slack_team_id`,`channel_id`,`ts`);--> statement-breakpoint
CREATE INDEX `slack_room_messages_post_idx` ON `slack_room_messages` (`post_id`);--> statement-breakpoint
CREATE TABLE `team_slack_links` (
	`channel_id` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`linked_by` text NOT NULL,
	`slack_team_id` text NOT NULL,
	`team_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_slack_links_team_unique` ON `team_slack_links` (`team_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `team_slack_links_channel_unique` ON `team_slack_links` (`slack_team_id`,`channel_id`);