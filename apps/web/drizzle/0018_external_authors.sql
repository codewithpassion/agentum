CREATE TABLE `external_authors` (
	`author_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`display_name` text NOT NULL,
	`link_source` text,
	`member_id` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `author_id`)
);
--> statement-breakpoint
CREATE INDEX `external_authors_member_idx` ON `external_authors` (`workspace_id`,`member_id`);