CREATE TABLE `oauth_states` (
	`connector_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`initiator_user_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`owner_kind` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`return_to` text NOT NULL,
	`state` text PRIMARY KEY NOT NULL,
	`verifier` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`connector_id`) REFERENCES `connectors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `oauth_states_expires_idx` ON `oauth_states` (`expires_at`);