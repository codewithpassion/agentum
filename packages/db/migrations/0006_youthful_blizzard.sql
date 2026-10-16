CREATE TABLE `agent_connectors` (
	`agent_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`created_at` text NOT NULL,
	`credential_mode` text DEFAULT 'user_or_agent' NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`agent_id`, `connector_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connector_id`) REFERENCES `connectors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `connectors` (
	`auth_kind` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`header_name` text,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`oauth` text,
	`status` text NOT NULL,
	`tools` text DEFAULT '[]' NOT NULL,
	`tools_fetched_at` text,
	`url` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `connectors_workspace_idx` ON `connectors` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`connector_id` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` text,
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`owner_kind` text NOT NULL,
	`refreshing_until` text,
	`scopes` text,
	`secret` text NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`connector_id`) REFERENCES `connectors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_owner_unique` ON `credentials` (`connector_id`,`owner_kind`,`owner_id`);