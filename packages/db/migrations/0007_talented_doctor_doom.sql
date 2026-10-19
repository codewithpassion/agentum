CREATE TABLE `workspace_model_keys` (
	`api_key_enc` text NOT NULL,
	`created_at` text NOT NULL,
	`key_hint` text NOT NULL,
	`provider` text NOT NULL,
	`set_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `provider`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
