ALTER TABLE `assistant_conversations` ADD `busy_until` text;--> statement-breakpoint
ALTER TABLE `assistant_conversations` ADD `lease_id` text;--> statement-breakpoint
ALTER TABLE `assistant_messages` ADD `tool_use_id` text;--> statement-breakpoint
-- Existing result messages contain exactly one tool_result block.
UPDATE `assistant_messages`
SET `tool_use_id` = json_extract(`content`, '$[0].tool_use_id')
WHERE json_extract(`content`, '$[0].type') = 'tool_result';--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_messages_tool_result` ON `assistant_messages` (`conversation_id`,`tool_use_id`);