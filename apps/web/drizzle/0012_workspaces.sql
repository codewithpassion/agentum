-- Multi-tenancy, phase 1: workspaces, and `workspace_id` on every root table.
--
-- !! DESTRUCTIVE: THIS MIGRATION ASSUMES THE DATABASE HOLDS NO PRE-0012 DATA. !!
-- It drops and recreates the eight root tables instead of altering them, so
-- every row in them is lost - and, through `ON DELETE CASCADE`, so is every row
-- in `messages`, `channel_members`, `message_mentions`, `attachments`,
-- `category_items` and `wiki_revisions`. `wiki_assets` is the one exception:
-- its foreign key is `ON DELETE SET NULL`, so those rows survive, orphaned,
-- with a null `page_id`. It was rewritten this way on a branch where the only
-- database that had ever run it was a local one
-- with nothing worth keeping and no remote D1 existed; from here on it only
-- ever runs against a fresh database. Do not apply it to a populated one.
--
-- The point of the rewrite: `ALTER TABLE ... ADD COLUMN ... NOT NULL` needs a
-- constant default, so the first version of this migration added every
-- `workspace_id` as `DEFAULT 'ws_default'` - and a default, once added, is part
-- of the table for good. That made raw SQL that forgot `workspace_id` land
-- silently in the default workspace instead of failing. The TypeScript schema
-- declares no default; now neither does the database.
--
-- Recreating the tables rather than copying into them is deliberate. The
-- copy-then-swap form (`CREATE new` / `INSERT ... SELECT` / `DROP old` /
-- `RENAME`) cannot survive `channels`, `categories` and `wiki_pages`, which are
-- `ON DELETE CASCADE` parents: `DROP TABLE` on a parent performs an implicit
-- `DELETE FROM`, and that fires the children's cascade actions. Cloudflare's
-- `PRAGMA defer_foreign_keys = true` does not help - it defers foreign key
-- *violations* until commit, not the cascade *actions*, and it is switched off
-- again at every COMMIT. Measured both ways (inside an explicit transaction and
-- out) the children were deleted regardless, so the copy would have preserved
-- the parents and thrown away everything hanging off them: worse than being
-- honest about it here.
CREATE TABLE `workspaces` (
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`clerk_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`email` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`image_url` text,
	`name` text,
	`role` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspace_members_clerk_idx` ON `workspace_members` (`clerk_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_members_user_idx` ON `workspace_members` (`workspace_id`,`clerk_user_id`);--> statement-breakpoint
-- Everything that exists belongs to one workspace. `ws_default` is a literal on
-- purpose: `DEFAULT_WORKSPACE_ID` in the workspaces module is the same string,
-- which is what lets the app name a workspace before the middleware that
-- resolves one exists. `create-dev-user` gives the dev user its membership.
INSERT INTO `workspaces` (`id`, `name`, `slug`) VALUES ('ws_default', 'Workspace', 'default');--> statement-breakpoint
-- The eight root tables, recreated with `workspace_id`. No foreign key to
-- `workspaces`: the TypeScript schema declares none, and adding one here would
-- be drift the drizzle snapshots do not know about.
DROP TABLE `agents`;--> statement-breakpoint
CREATE TABLE `agents` (
	`anthropic_agent_id` text,
	`avatar` text NOT NULL,
	`connector_resync_pending_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`mcp_token_hash` text,
	`memory_store_id` text,
	`name` text NOT NULL,
	`session_id` text,
	`soul` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`sync_error` text,
	`sync_status` text DEFAULT 'unregistered' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_mcp_token_hash_unique` ON `agents` (`mcp_token_hash`);--> statement-breakpoint
-- The uniques that become composite (`agents.name`, `connectors.url`,
-- `skills.slug`, `wiki_pages.slug`) lead with `workspace_id`, so the scoped
-- list reads of phase 3 ride on them; 0013 adds the same index to the four
-- tables that have no composite unique to ride on.
CREATE UNIQUE INDEX `agents_workspace_name_idx` ON `agents` (`workspace_id`,`name`);--> statement-breakpoint
DROP TABLE `categories`;--> statement-breakpoint
CREATE TABLE `categories` (
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
DROP TABLE `channel_bridges`;--> statement-breakpoint
CREATE TABLE `channel_bridges` (
	`agent_id` text,
	`channel_id` text NOT NULL,
	`connector` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`external_channel_id` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_bridges_channel_idx` ON `channel_bridges` (`channel_id`,`connector`);--> statement-breakpoint
CREATE UNIQUE INDEX `channel_bridges_external_idx` ON `channel_bridges` (`connector`,`external_channel_id`);--> statement-breakpoint
DROP TABLE `channels`;--> statement-breakpoint
CREATE TABLE `channels` (
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'channel' NOT NULL,
	`name` text NOT NULL,
	`origin` text DEFAULT 'native' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
DROP TABLE `connector_oauth_flows`;--> statement-breakpoint
CREATE TABLE `connector_oauth_flows` (
	`connector_id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`redirect_uri` text NOT NULL,
	`scope` text,
	`state` text NOT NULL,
	`verifier` text NOT NULL,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_oauth_flows_state_unique` ON `connector_oauth_flows` (`state`);--> statement-breakpoint
DROP TABLE `connectors`;--> statement-breakpoint
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
	`vault_id` text,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connectors_workspace_url_idx` ON `connectors` (`workspace_id`,`url`);--> statement-breakpoint
DROP TABLE `skills`;--> statement-breakpoint
CREATE TABLE `skills` (
	`anthropic_skill_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_by` text DEFAULT 'user' NOT NULL,
	`description` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`latest_version` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`sync_error` text,
	`sync_status` text DEFAULT 'unsynced' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_workspace_slug_idx` ON `skills` (`workspace_id`,`slug`);--> statement-breakpoint
DROP TABLE `wiki_pages`;--> statement-breakpoint
CREATE TABLE `wiki_pages` (
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wiki_pages_workspace_slug_idx` ON `wiki_pages` (`workspace_id`,`slug`);
