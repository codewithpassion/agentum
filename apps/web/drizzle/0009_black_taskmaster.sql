CREATE TABLE `agent_connectors` (
	`agent_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_connectors_pair_idx` ON `agent_connectors` (`agent_id`,`connector_id`);--> statement-breakpoint
CREATE TABLE `connector_oauth_flows` (
	`connector_id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`redirect_uri` text NOT NULL,
	`scope` text,
	`state` text NOT NULL,
	`verifier` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_oauth_flows_state_unique` ON `connector_oauth_flows` (`state`);--> statement-breakpoint
CREATE TABLE `connectors` (
	`auth_kind` text DEFAULT 'none' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_error` text,
	`mgmt_access_token_enc` text,
	`mgmt_error` text,
	`mgmt_expires_at` integer,
	`mgmt_refresh_token_enc` text,
	`name` text NOT NULL,
	`oauth_client_id` text,
	`oauth_client_secret_enc` text,
	`oauth_token_endpoint` text,
	`oauth_token_endpoint_auth` text,
	`status` text DEFAULT 'unconfigured' NOT NULL,
	`tool_cache` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`url` text NOT NULL,
	`vault_credential_id` text,
	`vault_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connectors_url_unique` ON `connectors` (`url`);