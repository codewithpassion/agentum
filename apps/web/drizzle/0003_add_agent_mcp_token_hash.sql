ALTER TABLE `agents` ADD `mcp_token_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_mcp_token_hash_unique` ON `agents` (`mcp_token_hash`);