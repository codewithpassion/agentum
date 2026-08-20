-- Routines: a named set of instructions for one agent plus a schedule, and the
-- history of its firings (docs/plan-routines.md). Additive - no existing table
-- is touched. `routine_runs` is created first and points at `routines`, which
-- SQLite resolves at write time rather than at CREATE.
CREATE TABLE `routine_runs` (
	`error` text,
	`fired_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`routine_id` text NOT NULL,
	`scheduled_for` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `routine_runs_routine_fired_idx` ON `routine_runs` (`routine_id`,`fired_at`);--> statement-breakpoint
CREATE TABLE `routines` (
	`agent_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`instructions` text NOT NULL,
	`name` text NOT NULL,
	`next_run_at` integer,
	`schedule` text NOT NULL,
	`timezone` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`workspace_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `routines_workspace_idx` ON `routines` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `routines_workspace_next_run_idx` ON `routines` (`workspace_id`,`next_run_at`);