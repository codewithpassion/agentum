ALTER TABLE `guest_sessions` ADD `previous_token_hash` text;--> statement-breakpoint
ALTER TABLE `guest_sessions` ADD `previous_valid_until` text;--> statement-breakpoint
CREATE INDEX `guest_sessions_previous_token_idx` ON `guest_sessions` (`previous_token_hash`);