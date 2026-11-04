CREATE TABLE `artifact_endpoints` (
	`artifact_id` text NOT NULL,
	`created_at` text NOT NULL,
	`disabled_at` text,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_endpoints_active_name_unique` ON `artifact_endpoints` (`artifact_id`,`name`) WHERE "artifact_endpoints"."disabled_at" IS NULL;--> statement-breakpoint
ALTER TABLE `triggers` ADD `artifact_id` text REFERENCES artifacts(id);