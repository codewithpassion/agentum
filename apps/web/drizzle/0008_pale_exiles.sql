CREATE TABLE `categories` (
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `category_items` (
	`category_id` text NOT NULL,
	`item_id` text NOT NULL,
	`item_type` text NOT NULL,
	PRIMARY KEY(`item_type`, `item_id`),
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
