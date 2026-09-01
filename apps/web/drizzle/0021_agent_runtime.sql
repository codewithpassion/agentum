-- Agent runtime (managed Anthropic sessions, or our own loop on Cloudflare).
-- Every existing agent keeps running as it did.
ALTER TABLE `agents` ADD `runtime` text DEFAULT 'managed' NOT NULL;