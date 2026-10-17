CREATE TABLE `managed_skills` (
	`agent_id` text NOT NULL,
	`anthropic_skill_id` text NOT NULL,
	`anthropic_version` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`name` text NOT NULL,
	`synced_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`agent_id`, `name`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
