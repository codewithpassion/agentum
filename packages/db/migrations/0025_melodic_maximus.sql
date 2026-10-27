CREATE TABLE `artifact_comment_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`anchor` text,
	`quote` text,
	`to_agent` integer DEFAULT false NOT NULL,
	`answered_at` text,
	`resolved_at` text,
	`resolved_by` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `artifact_comment_threads_artifact_idx` ON `artifact_comment_threads` (`artifact_id`);--> statement-breakpoint
CREATE TABLE `artifact_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`author_kind` text NOT NULL,
	`author_id` text NOT NULL,
	`run_id` text,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`edited_at` text,
	`deleted_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_id`) REFERENCES `artifact_comment_threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "artifact_comments_body_bytes" CHECK(length(CAST("artifact_comments"."body" AS BLOB)) <= 4096)
);
--> statement-breakpoint
CREATE INDEX `artifact_comments_thread_idx` ON `artifact_comments` (`thread_id`);--> statement-breakpoint
CREATE TABLE `artifact_live_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`run_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`summary` text NOT NULL,
	`rev_from` integer NOT NULL,
	`rev_to` integer NOT NULL,
	`created_at` text NOT NULL,
	`reverted_at` text,
	`reverted_by` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "artifact_live_changes_revisions" CHECK("artifact_live_changes"."rev_from" >= 0 AND "artifact_live_changes"."rev_to" > "artifact_live_changes"."rev_from")
);
--> statement-breakpoint
CREATE INDEX `artifact_live_changes_artifact_idx` ON `artifact_live_changes` (`artifact_id`);--> statement-breakpoint
CREATE TABLE `artifact_members` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`principal_kind` text NOT NULL,
	`user_id` text,
	`guest_id` text,
	`role` text NOT NULL,
	`expires_at` text,
	`agent_runs_per_day` integer DEFAULT 20 NOT NULL,
	`revoked_at` text,
	`revoked_by` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`guest_id`) REFERENCES `guest_identities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "artifact_members_principal" CHECK(("artifact_members"."principal_kind" = 'user' AND "artifact_members"."user_id" IS NOT NULL AND "artifact_members"."guest_id" IS NULL) OR ("artifact_members"."principal_kind" = 'guest' AND "artifact_members"."guest_id" IS NOT NULL AND "artifact_members"."user_id" IS NULL AND "artifact_members"."expires_at" IS NOT NULL)),
	CONSTRAINT "artifact_members_cap" CHECK("artifact_members"."agent_runs_per_day" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_members_user_unique` ON `artifact_members` (`artifact_id`,`user_id`) WHERE "artifact_members"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_members_guest_unique` ON `artifact_members` (`artifact_id`,`guest_id`) WHERE "artifact_members"."revoked_at" IS NULL;--> statement-breakpoint
CREATE TABLE `guest_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`guest_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`guest_id`) REFERENCES `guest_identities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "guest_codes_attempts" CHECK("guest_codes"."attempts" >= 0 AND "guest_codes"."attempts" <= 5)
);
--> statement-breakpoint
CREATE INDEX `guest_codes_guest_idx` ON `guest_codes` (`guest_id`);--> statement-breakpoint
CREATE TABLE `guest_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "guest_email_lowercase" CHECK("guest_identities"."email" = lower("guest_identities"."email"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_identities_email_unique` ON `guest_identities` (`workspace_id`,`email`);--> statement-breakpoint
CREATE TABLE `guest_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`member_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`used_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `artifact_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_invites_token_hash_unique` ON `guest_invites` (`token_hash`);--> statement-breakpoint
CREATE TABLE `guest_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`guest_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_used_at` text NOT NULL,
	`ip_prefix` text,
	`user_agent` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`guest_id`) REFERENCES `guest_identities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_sessions_token_hash_unique` ON `guest_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `guest_sessions_guest_idx` ON `guest_sessions` (`guest_id`);--> statement-breakpoint
ALTER TABLE `artifacts` ADD `live_room_rev` integer;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `converted_from_id` text REFERENCES artifacts(id);--> statement-breakpoint
ALTER TABLE `runs` ADD `scope_artifact_id` text REFERENCES artifacts(id);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `live_guests_enabled` integer DEFAULT true NOT NULL;