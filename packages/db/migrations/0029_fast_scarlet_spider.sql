CREATE TABLE `guest_auth_rate_buckets` (
	`count` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`limit` integer NOT NULL,
	`subject_hash` text NOT NULL,
	`window_start` integer NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "guest_auth_rate_bucket_count" CHECK("guest_auth_rate_buckets"."count" >= 0 AND "guest_auth_rate_buckets"."limit" > 0 AND "guest_auth_rate_buckets"."count" <= "guest_auth_rate_buckets"."limit"),
	CONSTRAINT "guest_auth_rate_bucket_kind" CHECK("guest_auth_rate_buckets"."kind" IN ('invite', 'email', 'ip_prefix'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_auth_rate_bucket_unique` ON `guest_auth_rate_buckets` (`workspace_id`,`kind`,`subject_hash`,`window_start`);--> statement-breakpoint
CREATE INDEX `guest_auth_rate_bucket_expiry_idx` ON `guest_auth_rate_buckets` (`expires_at`);--> statement-breakpoint
ALTER TABLE `guest_codes` ADD `consumed_at` text;--> statement-breakpoint
-- Legacy ten-minute challenges have no trustworthy invitation binding. Invalidate
-- them before adding the required FK; guests can explicitly request a new code.
DELETE FROM `guest_codes`;--> statement-breakpoint
ALTER TABLE `guest_codes` ADD `invite_id` text NOT NULL REFERENCES guest_invites(id);--> statement-breakpoint
CREATE INDEX `guest_codes_invite_idx` ON `guest_codes` (`workspace_id`,`invite_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `guest_codes_active_invite_unique` ON `guest_codes` (`workspace_id`,`invite_id`) WHERE "guest_codes"."consumed_at" IS NULL;