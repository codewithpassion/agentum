ALTER TABLE `agents` ADD `email_local` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `hands_to` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `soul` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_email_local_unique` ON `agents` (`email_local`);--> statement-breakpoint
ALTER TABLE `runs` ADD `dry_run` integer DEFAULT false NOT NULL;