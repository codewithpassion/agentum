ALTER TABLE `agents` ADD `ask_level` text DEFAULT 'rarely' NOT NULL;
--> statement-breakpoint
UPDATE `agents` SET `ask_level` = 'custom' WHERE `id` IN (SELECT `agent_id` FROM `agent_tool_rules`);
