DROP INDEX `oauth_clients_client_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_clients_client_workspace_unique` ON `oauth_clients` (`client_id`,`workspace_id`);