CREATE TABLE `agent_library_access` (
	`agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	`mode` text NOT NULL,
	`path` text NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`agent_id`, `path`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `library_conflicts` (
	`agent_id` text NOT NULL,
	`conflict_path` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`resolution` text,
	`resolved_at` text,
	`run_id` text,
	`status` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `library_conflicts_status_idx` ON `library_conflicts` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `library_links` (
	`from_path` text NOT NULL,
	`target` text NOT NULL,
	`target_key` text NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `from_path`, `target`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `library_links_target_idx` ON `library_links` (`workspace_id`,`target_key`);--> statement-breakpoint
CREATE TABLE `library_versions` (
	`author_id` text NOT NULL,
	`author_kind` text NOT NULL,
	`blob_key` text,
	`created_at` text NOT NULL,
	`etag` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`op` text NOT NULL,
	`path` text NOT NULL,
	`run_id` text,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`version` integer NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_versions_path_version_unique` ON `library_versions` (`workspace_id`,`path`,`version`);--> statement-breakpoint
CREATE TABLE `wiki_suggestions` (
	`agent_id` text NOT NULL,
	`base_version_id` text,
	`blob_key` text NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text,
	`decided_by` text,
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`result_version_id` text,
	`run_id` text,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`base_version_id`) REFERENCES `library_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_version_id`) REFERENCES `library_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `wiki_suggestions_status_idx` ON `wiki_suggestions` (`workspace_id`,`status`);--> statement-breakpoint
-- Hand-written: each agent's runtimeConfig.libraryPaths becomes a write grant.
-- Every agent is copied, archived and draft ones too. The primary key absorbs
-- duplicates, so running this statement twice is safe. Empty and non-text
-- entries are skipped. Anything saved to libraryPaths after this runs is not
-- copied.
INSERT OR IGNORE INTO `agent_library_access` (`agent_id`, `created_at`, `mode`, `path`, `workspace_id`)
SELECT `agents`.`id`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'write', trim(`paths`.`value`, '/'), `agents`.`workspace_id`
FROM `agents`, json_each(
  CASE WHEN json_valid(`agents`.`runtime_config`)
    THEN CASE WHEN json_type(`agents`.`runtime_config`, '$.libraryPaths') = 'array'
      THEN json_extract(`agents`.`runtime_config`, '$.libraryPaths')
      ELSE '[]' END
    ELSE '[]' END
) AS `paths`
WHERE `paths`.`type` = 'text' AND trim(`paths`.`value`, '/') <> '';
