CREATE TABLE `agent_secrets` (
	`agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	`secret_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`agent_id`, `secret_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`secret_id`) REFERENCES `secrets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `secrets` (
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`name` text NOT NULL,
	`rules` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL,
	`value_enc` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secrets_workspace_name_unique` ON `secrets` (`workspace_id`,`name`);