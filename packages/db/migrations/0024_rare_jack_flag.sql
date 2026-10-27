CREATE TABLE `artifact_grants` (
	`created_at` text NOT NULL,
	`decided_at` text,
	`decided_by` text,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`target` text NOT NULL,
	`version_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `artifact_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `artifact_grants_version_idx` ON `artifact_grants` (`version_id`);--> statement-breakpoint
CREATE TABLE `artifact_pins` (
	`artifact_id` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	`surface` text NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_pins_unique` ON `artifact_pins` (`user_id`,`artifact_id`,`surface`);--> statement-breakpoint
CREATE TABLE `artifact_shares` (
	`artifact_id` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`data_mode` text DEFAULT 'snapshot' NOT NULL,
	`expires_at` text,
	`granted_by` text,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`last_opened_at` text,
	`live_tools` text,
	`open_count` integer DEFAULT 0 NOT NULL,
	`revoked_at` text,
	`revoked_by` text,
	`token_encrypted` text NOT NULL,
	`token_hash` text NOT NULL,
	`version_id` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_id`) REFERENCES `artifact_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_shares_token_hash_unique` ON `artifact_shares` (`token_hash`);--> statement-breakpoint
CREATE INDEX `artifact_shares_artifact_idx` ON `artifact_shares` (`artifact_id`);--> statement-breakpoint
CREATE TABLE `artifact_version_files` (
	`content_type` text NOT NULL,
	`path` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`version_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`version_id`, `path`),
	FOREIGN KEY (`version_id`) REFERENCES `artifact_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `artifact_versions` (
	`artifact_id` text NOT NULL,
	`author_id` text NOT NULL,
	`author_kind` text NOT NULL,
	`author_run_id` text,
	`created_at` text NOT NULL,
	`entry` text NOT NULL,
	`file_count` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`manifest_key` text NOT NULL,
	`message` text NOT NULL,
	`number` integer NOT NULL,
	`parent_number` integer,
	`source_commit_sha` text,
	`source_library_path` text,
	`status` text NOT NULL,
	`thumbnail_key` text,
	`total_bytes` integer NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_versions_number_unique` ON `artifact_versions` (`artifact_id`,`number`);--> statement-breakpoint
CREATE TABLE `artifact_view_salts` (
	`day` text NOT NULL,
	`salt` text NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `day`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `artifact_views` (
	`artifact_id` text NOT NULL,
	`asn` text,
	`as_org` text,
	`city` text,
	`country` text,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`ip_prefix` text,
	`outcome` text NOT NULL,
	`referrer_host` text,
	`region` text,
	`share_id` text,
	`surface` text NOT NULL,
	`tool_key` text,
	`user_agent` text,
	`user_id` text,
	`version_id` text,
	`visitor_hash` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`share_id`) REFERENCES `artifact_shares`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_id`) REFERENCES `artifact_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `artifact_views_artifact_idx` ON `artifact_views` (`artifact_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `artifact_views_share_idx` ON `artifact_views` (`share_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`agent_id` text,
	`audience` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_by_kind` text NOT NULL,
	`current_version_id` text,
	`deleted_at` text,
	`deleted_by` text,
	`description` text,
	`handed_to_agent_id` text,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`owner_user_id` text,
	`run_id` text,
	`session_id` text,
	`thumbnail_key` text,
	`title` text NOT NULL,
	`updated_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`handed_to_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `artifacts_workspace_updated_idx` ON `artifacts` (`workspace_id`,`updated_at`);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `artifact_links_enabled` integer DEFAULT true NOT NULL;