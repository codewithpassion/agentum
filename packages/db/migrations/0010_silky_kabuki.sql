ALTER TABLE `runs` ADD `slack_status_at` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `slack_status_label` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `slack_status_stopped` integer DEFAULT false NOT NULL;