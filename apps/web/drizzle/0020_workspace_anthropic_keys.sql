CREATE TABLE `workspace_anthropic_keys` (
	`api_key_enc` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`key_hint` text NOT NULL,
	`set_by_clerk_user_id` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`workspace_id` text PRIMARY KEY NOT NULL
);
