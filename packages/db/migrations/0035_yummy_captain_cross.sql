ALTER TABLE `agents` ADD `backup_user_id` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `attention_cleared_at` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `attention_cleared_by` text;