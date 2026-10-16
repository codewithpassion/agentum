CREATE TABLE `library_entries` (
	`etag` text,
	`kind` text NOT NULL,
	`mtime` text NOT NULL,
	`parent` text NOT NULL,
	`path` text NOT NULL,
	`size` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`updated_by_kind` text NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `path`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `library_entries_parent_idx` ON `library_entries` (`workspace_id`,`parent`);