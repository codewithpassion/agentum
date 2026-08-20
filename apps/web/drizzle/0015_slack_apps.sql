-- Slack app per agent: `slack_apps`, and the bridge's link to the app it
-- belongs to.
--
-- !! DESTRUCTIVE: THIS MIGRATION DROPS EVERY ROW IN `channel_bridges`. !!
-- `slack_app_id` is NOT NULL with no sensible default - an existing bridge
-- belongs to no app, because until now there were none - and SQLite refuses
-- `ADD COLUMN ... NOT NULL` without a constant default. So the table is
-- recreated rather than altered, following 0012's fresh-DB precedent: both
-- databases this ever runs against (local and production) hold no bridges, and
-- the deployment-level Slack credentials it replaces were never used to bridge
-- anything. Do not apply it to a database with bridges worth keeping - rebuild
-- them through the wizard instead.
CREATE TABLE `slack_apps` (
	`agent_id` text NOT NULL,
	`bot_token_enc` text,
	`bot_user_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_error` text,
	`signing_secret_enc` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`team_id` text,
	`team_name` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `slack_apps_workspace_idx` ON `slack_apps` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `slack_apps_agent_idx` ON `slack_apps` (`agent_id`);--> statement-breakpoint
DROP TABLE `channel_bridges`;--> statement-breakpoint
CREATE TABLE `channel_bridges` (
	`agent_id` text,
	`channel_id` text NOT NULL,
	`connector` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`external_channel_id` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`slack_app_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_bridges_channel_idx` ON `channel_bridges` (`channel_id`,`connector`);--> statement-breakpoint
CREATE UNIQUE INDEX `channel_bridges_external_idx` ON `channel_bridges` (`connector`,`external_channel_id`);--> statement-breakpoint
CREATE INDEX `channel_bridges_workspace_idx` ON `channel_bridges` (`workspace_id`);
