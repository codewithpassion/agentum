CREATE TABLE `agent_mailboxes` (
	`address` text NOT NULL,
	`agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_error` text,
	`routing_rule_id` text,
	`status` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_mailboxes_address_unique` ON `agent_mailboxes` (`address`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_mailboxes_agent_unique` ON `agent_mailboxes` (`agent_id`);--> statement-breakpoint
CREATE TABLE `mail_messages` (
	`cc_addresses` text NOT NULL,
	`created_at` text NOT NULL,
	`direction` text NOT NULL,
	`external_message_id` text NOT NULL,
	`from_address` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text,
	`rfc_message_id` text,
	`run_id` text,
	`snippet` text NOT NULL,
	`status` text NOT NULL,
	`subject` text NOT NULL,
	`thread_id` text NOT NULL,
	`to_addresses` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `run_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_id`) REFERENCES `mail_threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_messages_external_unique` ON `mail_messages` (`thread_id`,`external_message_id`);--> statement-breakpoint
CREATE INDEX `mail_messages_thread_created_idx` ON `mail_messages` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `mail_messages_rfc_idx` ON `mail_messages` (`workspace_id`,`rfc_message_id`);--> statement-breakpoint
CREATE INDEX `mail_messages_run_idx` ON `mail_messages` (`run_id`);--> statement-breakpoint
CREATE INDEX `mail_messages_request_idx` ON `mail_messages` (`request_id`);--> statement-breakpoint
CREATE TABLE `mail_threads` (
	`external_thread_id` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_message_at` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`session_id` text,
	`subject` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `agent_mailboxes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_threads_external_unique` ON `mail_threads` (`mailbox_id`,`external_thread_id`);--> statement-breakpoint
CREATE INDEX `mail_threads_workspace_last_idx` ON `mail_threads` (`workspace_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `mail_threads_session_idx` ON `mail_threads` (`session_id`);