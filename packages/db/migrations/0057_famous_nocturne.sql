CREATE TABLE `inbox_thread_members` (
	`member_id` text NOT NULL,
	`member_kind` text NOT NULL,
	`thread_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`thread_id`, `member_kind`, `member_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `inbox_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `member_profiles` (
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_profiles_handle_unique` ON `member_profiles` (`workspace_id`,`handle`);--> statement-breakpoint
CREATE TABLE `team_members` (
	`is_home` integer DEFAULT false NOT NULL,
	`member_id` text NOT NULL,
	`member_kind` text NOT NULL,
	`team_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`team_id`, `member_kind`, `member_id`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `team_members_member_idx` ON `team_members` (`member_kind`,`member_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`archived_at` text,
	`created_at` text NOT NULL,
	`folder_path` text,
	`id` text PRIMARY KEY NOT NULL,
	`lead_agent_id` text,
	`lead_listens` integer DEFAULT true NOT NULL,
	`name` text NOT NULL,
	`owner_user_id` text,
	`rules` text DEFAULT '' NOT NULL,
	`slug` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`lead_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_slug_unique` ON `teams` (`workspace_id`,`slug`);--> statement-breakpoint
ALTER TABLE `inbox_threads` ADD `opened_by_agent_id` text REFERENCES agents(id);--> statement-breakpoint
ALTER TABLE `inbox_threads` ADD `team_id` text REFERENCES teams(id);--> statement-breakpoint
CREATE INDEX `inbox_threads_team_idx` ON `inbox_threads` (`team_id`,`last_post_at`);--> statement-breakpoint
INSERT INTO `teams` (`id`, `workspace_id`, `name`, `slug`, `lead_agent_id`, `owner_user_id`, `rules`, `lead_listens`, `folder_path`, `created_at`, `archived_at`) SELECT 'team_' || lower(hex(randomblob(10))), `id`, 'Everyone', 'everyone', NULL, NULL, '', 1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL FROM `workspaces`;--> statement-breakpoint
UPDATE `inbox_threads` SET `team_id` = (SELECT `teams`.`id` FROM `teams` WHERE `teams`.`workspace_id` = `inbox_threads`.`workspace_id` AND `teams`.`slug` = 'everyone');
