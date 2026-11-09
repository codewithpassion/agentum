ALTER TABLE `connectors` ADD `header_template` text;--> statement-breakpoint
ALTER TABLE `connectors` ADD `secret_id` text REFERENCES secrets(id);