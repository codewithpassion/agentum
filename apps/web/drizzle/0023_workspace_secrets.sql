CREATE TABLE `agent_secrets` (
	`agent_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`secret_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_secrets_pair_idx` ON `agent_secrets` (`agent_id`,`secret_id`);--> statement-breakpoint
CREATE TABLE `workspace_secrets` (
	`allowed_hosts` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`header` text DEFAULT 'Authorization' NOT NULL,
	`header_prefix` text DEFAULT 'Bearer ' NOT NULL,
	`hint` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`last_used_at` integer,
	`name` text NOT NULL,
	`set_by_clerk_user_id` text NOT NULL,
	`sync_error` text,
	`sync_status` text DEFAULT 'unregistered' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`value_enc` text NOT NULL,
	`vault_credential_id` text,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_secrets_workspace_name_idx` ON `workspace_secrets` (`workspace_id`,`name`);