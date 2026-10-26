CREATE INDEX `runs_workspace_status_idx` ON `runs` (`workspace_id`,`status`);--> statement-breakpoint
CREATE INDEX `runs_workspace_finished_idx` ON `runs` (`workspace_id`,`finished_at`);--> statement-breakpoint
CREATE INDEX `runs_agent_status_idx` ON `runs` (`agent_id`,`status`);