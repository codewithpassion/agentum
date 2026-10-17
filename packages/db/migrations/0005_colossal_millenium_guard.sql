CREATE TABLE `skill_assignments` (
	`agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	`pinned_version_id` text,
	`skill_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`agent_id`, `skill_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pinned_version_id`) REFERENCES `skill_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `skill_assignments_skill_idx` ON `skill_assignments` (`skill_id`);--> statement-breakpoint
CREATE TABLE `skill_library_migrations` (
	`migrated_at` text NOT NULL,
	`workspace_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `skill_version_files` (
	`executable` integer DEFAULT false NOT NULL,
	`hash` text NOT NULL,
	`path` text NOT NULL,
	`size` integer NOT NULL,
	`version_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`version_id`, `path`),
	FOREIGN KEY (`version_id`) REFERENCES `skill_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `skill_versions` (
	`approved_at` text,
	`approved_by` text,
	`author_id` text NOT NULL,
	`author_kind` text NOT NULL,
	`author_run_id` text,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`message` text NOT NULL,
	`number` integer NOT NULL,
	`parent_number` integer,
	`skill_id` text NOT NULL,
	`status` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_versions_number_unique` ON `skill_versions` (`skill_id`,`number`);--> statement-breakpoint
CREATE TABLE `skills` (
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`created_by_kind` text NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_agent_id` text,
	`updated_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`owner_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_agent_name_unique` ON `skills` (`workspace_id`,`owner_agent_id`,`name`) WHERE "skills"."owner_agent_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `skills_people_name_unique` ON `skills` (`workspace_id`,`name`) WHERE "skills"."owner_agent_id" IS NULL;