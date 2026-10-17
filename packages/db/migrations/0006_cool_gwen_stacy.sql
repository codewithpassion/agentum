CREATE TABLE `managed_skill_versions` (
	`anthropic_skill_id` text NOT NULL,
	`anthropic_version` text NOT NULL,
	`created_at` text NOT NULL,
	`skill_id` text NOT NULL,
	`version` integer NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`skill_id`, `version`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
