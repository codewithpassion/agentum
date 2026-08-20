-- Multi-tenancy, phase 3: the `workspace_id` indexes the scoped list reads need.
--
-- `agents`, `connectors`, `skills` and `wiki_pages` already lead with
-- `workspace_id` in the composite uniques migration 0012 created. These four
-- have no such index to ride on, and every read of them is now "…of this
-- workspace".
CREATE INDEX `channel_bridges_workspace_idx` ON `channel_bridges` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `categories_workspace_idx` ON `categories` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `connector_oauth_flows_workspace_idx` ON `connector_oauth_flows` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `channels_workspace_idx` ON `channels` (`workspace_id`);
