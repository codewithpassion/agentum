-- Multi-tenancy, phase 1: workspaces, and `workspace_id` on every root table.
--
-- Two notes on the mechanics, both forced by SQLite:
--
-- 1. `ADD COLUMN ... NOT NULL` needs a constant default, so every column is
--    added with the default workspace's id - which is exactly the backfill the
--    existing rows want. The default stays on the table afterwards (dropping it
--    would mean a rebuild); the TypeScript schema declares no default, so every
--    insert the app makes still has to name its workspace.
-- 2. The uniques that become composite (`agents.name`, `connectors.url`,
--    `skills.slug`, `wiki_pages.slug`) are plain indexes rather than table
--    constraints, so swapping them needs no table rebuild either. That matters:
--    dropping and recreating `channels`, `categories` or `wiki_pages` would
--    fire `ON DELETE CASCADE` on their children and take the messages, category
--    items and revisions with them.
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
-- Everything that exists today belongs to one workspace. `ws_default` is a
-- literal on purpose: `DEFAULT_WORKSPACE_ID` in the workspaces module is the
-- same string, which is what lets the app name a workspace before the
-- middleware that resolves one exists.
INSERT INTO `workspaces` (`id`, `name`, `slug`) VALUES ('ws_default', 'Workspace', 'default');--> statement-breakpoint
ALTER TABLE `agents` ADD `workspace_id` text DEFAULT 'ws_default' NOT NULL;--> statement-breakpoint
ALTER TABLE `categories` ADD `workspace_id` text DEFAULT 'ws_default' NOT NULL;--> statement-breakpoint
ALTER TABLE `channel_bridges` ADD `workspace_id` text DEFAULT 'ws_default' NOT NULL;--> statement-breakpoint
ALTER TABLE `channels` ADD `workspace_id` text DEFAULT 'ws_default' NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_oauth_flows` ADD `workspace_id` text DEFAULT 'ws_default' NOT NULL;--> statement-breakpoint
ALTER TABLE `connectors` ADD `workspace_id` text DEFAULT 'ws_default' NOT NULL;--> statement-breakpoint
ALTER TABLE `skills` ADD `workspace_id` text DEFAULT 'ws_default' NOT NULL;--> statement-breakpoint
ALTER TABLE `wiki_pages` ADD `workspace_id` text DEFAULT 'ws_default' NOT NULL;--> statement-breakpoint
DROP INDEX `agents_name_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_workspace_name_idx` ON `agents` (`workspace_id`,`name`);--> statement-breakpoint
DROP INDEX `connectors_url_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `connectors_workspace_url_idx` ON `connectors` (`workspace_id`,`url`);--> statement-breakpoint
DROP INDEX `skills_slug_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `skills_workspace_slug_idx` ON `skills` (`workspace_id`,`slug`);--> statement-breakpoint
DROP INDEX `wiki_pages_slug_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `wiki_pages_workspace_slug_idx` ON `wiki_pages` (`workspace_id`,`slug`);--> statement-breakpoint
-- Every Clerk user who left a trace in the data becomes an owner of the default
-- workspace. Emails are filled in afterwards, against the Clerk API, by
-- `scripts/backfill-workspace-members.ts` - SQL has no way to ask.
INSERT OR IGNORE INTO `workspace_members` (`clerk_user_id`, `email`, `id`, `role`, `workspace_id`)
SELECT
	`clerk_user_id`,
	'',
	-- A v4 UUID, so backfilled ids look like the `crypto.randomUUID()` ones the
	-- app writes from here on.
	lower(
		hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
		substr(hex(randomblob(2)), 2) || '-' ||
		substr('89ab', 1 + (random() & 3), 1) || substr(hex(randomblob(2)), 2) ||
		'-' || hex(randomblob(6))
	),
	'owner',
	'ws_default'
FROM (
	SELECT DISTINCT `author_id` AS `clerk_user_id` FROM `messages` WHERE `author_type` = 'user'
	UNION
	SELECT DISTINCT `member_id` FROM `channel_members` WHERE `member_type` = 'user'
	UNION
	SELECT DISTINCT `author_id` FROM `wiki_revisions` WHERE `author_type` = 'user'
);
