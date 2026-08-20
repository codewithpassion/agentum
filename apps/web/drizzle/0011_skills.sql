CREATE TABLE `agent_skills` (
	`agent_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`pinned_version` integer,
	`skill_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_skills_pair_idx` ON `agent_skills` (`agent_id`,`skill_id`);--> statement-breakpoint
CREATE TABLE `skill_files` (
	`content_type` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`r2_key` text NOT NULL,
	`size` integer NOT NULL,
	`skill_version_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skill_versions` (
	`anthropic_version` text,
	`changelog` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_by` text DEFAULT 'user' NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`version` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_versions_number_idx` ON `skill_versions` (`skill_id`,`version`);--> statement-breakpoint
CREATE TABLE `skills` (
	`anthropic_skill_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_by` text DEFAULT 'user' NOT NULL,
	`description` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`latest_version` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`sync_error` text,
	`sync_status` text DEFAULT 'unsynced' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_slug_unique` ON `skills` (`slug`);