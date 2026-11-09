ALTER TABLE `sessions` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `parent_session_id` text REFERENCES sessions(id);--> statement-breakpoint
ALTER TABLE `sessions` ADD `pinned_at` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `title` text;--> statement-breakpoint
CREATE INDEX `sessions_last_run_idx` ON `sessions` (`workspace_id`,`last_run_at`);--> statement-breakpoint
UPDATE `sessions` SET `parent_session_id` = (
  SELECT p.`session_id` FROM `runs` p WHERE p.`id` = (
    SELECT r.`parent_run_id` FROM `runs` r WHERE r.`session_id` = `sessions`.`id`
    ORDER BY r.`created_at`, r.`id` LIMIT 1
  )
) WHERE `parent_session_id` IS NULL AND (
  SELECT p.`session_id` FROM `runs` p WHERE p.`id` = (
    SELECT r.`parent_run_id` FROM `runs` r WHERE r.`session_id` = `sessions`.`id`
    ORDER BY r.`created_at`, r.`id` LIMIT 1
  )
) <> `sessions`.`id`;--> statement-breakpoint
UPDATE `sessions` SET `title` = (
  SELECT CASE WHEN length(trim(replace(replace(r.`input_text`, char(10), ' '), char(13), ' '))) > 60
    THEN substr(trim(replace(replace(r.`input_text`, char(10), ' '), char(13), ' ')), 1, 60) || '...'
    ELSE trim(replace(replace(r.`input_text`, char(10), ' '), char(13), ' ')) END
  FROM `runs` r WHERE r.`session_id` = `sessions`.`id` ORDER BY r.`created_at`, r.`id` LIMIT 1
) WHERE `title` IS NULL AND `actor_kind` <> 'trigger' AND `origin` NOT IN ('inbox', 'slack', 'mail', 'dry_run');--> statement-breakpoint
UPDATE `sessions` SET `title` = NULL WHERE `title` = '';
