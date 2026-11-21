ALTER TABLE `inbox_posts` ADD `guest_name` text;
--> statement-breakpoint
UPDATE `inbox_posts` SET `guest_name` = substr(`text`, 1, instr(`text`, ' (Slack guest): ') - 1), `text` = substr(`text`, instr(`text`, ' (Slack guest): ') + 16) WHERE `author_kind` = 'user' AND substr(`author_id`, 1, 6) = 'slack:' AND instr(`text`, ' (Slack guest): ') > 1;
--> statement-breakpoint
UPDATE `inbox_posts` SET `guest_name` = 'Someone' WHERE `author_kind` = 'user' AND substr(`author_id`, 1, 6) = 'slack:' AND `guest_name` IS NULL;
