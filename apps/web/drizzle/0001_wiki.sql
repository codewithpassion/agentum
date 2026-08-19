CREATE TABLE `wiki_assets` (
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`filename` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`mime` text NOT NULL,
	`page_id` text,
	`r2_key` text NOT NULL,
	`size` integer NOT NULL,
	FOREIGN KEY (`page_id`) REFERENCES `wiki_pages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `wiki_assets_page_idx` ON `wiki_assets` (`page_id`);--> statement-breakpoint
CREATE TABLE `wiki_pages` (
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wiki_pages_slug_unique` ON `wiki_pages` (`slug`);--> statement-breakpoint
CREATE TABLE `wiki_revisions` (
	`author_id` text NOT NULL,
	`author_type` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`page_id` text NOT NULL,
	`title` text NOT NULL,
	FOREIGN KEY (`page_id`) REFERENCES `wiki_pages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `wiki_revisions_page_created_idx` ON `wiki_revisions` (`page_id`,`created_at`);