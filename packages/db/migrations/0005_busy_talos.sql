-- machine_enroll_tokens has no writer before M1.1, so every database holds zero
-- rows and SQLite accepts the NOT NULL column without a default.
ALTER TABLE `machine_enroll_tokens` ADD `created_by` text NOT NULL;
