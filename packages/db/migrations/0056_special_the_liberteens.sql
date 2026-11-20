ALTER TABLE `agents` ADD `paused_at` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `paused_reason` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `weekly_cap_cents` integer;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `weekly_cap_cents` integer;