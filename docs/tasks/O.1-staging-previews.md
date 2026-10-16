---
id: O.1
title: Staging and previews
milestone: O
size: S
status: blocked
depends_on: [M0.7, M0.8]
branch: null
---

From `docs/architecture/build-plan.html#ops`. Automation lane, first task after M0. The M1 gate's second-machine check (M1.4s), M2.2's and M5.2's live tests wait for it.

## Scope

Run `setup-previews`, set `CLOUDFLARE_API_TOKEN`, add every new binding to `env.staging` and `env.staging.previews` (DO migrations and crons stay top-level), put secrets with `wrangler secret put` and `wrangler preview base-config secret put --env staging`.

Deploy rule: a release that creates or renames a Durable Object class (the first deploy of `MachineRelay`, and `ManagedPoller` if M8 happens) goes out as `wrangler d1 migrations apply DB --remote` then `wrangler deploy`, because Cloudflare refuses `versions upload` for DO lifecycle changes. Every other release: build, `versions upload`, migrate, `versions deploy`, `wrangler triggers deploy`. The repo's existing deploy script already uses `wrangler deploy`.

## Check

A PR gets a preview URL whose `/api/health` answers; `https://<staging>/api/health` answers; `https://<staging>/api/machines/ping-do` answers from the DO; a routine on staging fires within two minutes of `wrangler triggers deploy`.

## Log
- 2026-10-16: blocked, staging is deferred until Dom says deploy.
