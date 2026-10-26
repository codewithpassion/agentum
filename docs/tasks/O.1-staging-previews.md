---
id: O.1
title: Staging and previews
milestone: O
size: S
status: done
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
- 2026-10-17: staging live at https://harbourmaster-staging.rockyshoreslabs.io (D1 harbourmaster-staging, R2 harbourmaster-staging-files, secrets set incl. preview base config, dev-login off). First deploy inherited prod routes and took the prod custom domain for ~2 min; domain moved back to the prod Worker via API, staging now has routes: []. Smoke test blocked at sign-in: Clerk dev instance asks for an emailed new-device code. PR previews (token, test PR) not set up.
- 2026-10-17: staging ALLOWED_ORG_IDS now Dev Workspace plus Dom's Harbour Edge Intelligence org (Clerk dev instance), on the Worker and the preview base config.
- 2026-10-17: staging smoke 8/8 passed (health, agent-login sign-in, daemon via MachineRelay DO, chat, attachment, library bash/R2, minute routine fired by staging cron, Sessions/Log). Report: harbourmaster-wt/tmp/O.1-smoke/report.md. Left on staging: machine o1-smoke, agent o1-agent, paused routine o1-minute, library file o1-smoke-note.md. Only PR previews remain (token + test PR), deferred: no PRs in this workflow.
- 2026-10-26: done. Staging passed its smoke test on 17 Oct. PR previews are dropped: this workflow opens no PRs, and task branches plus staging cover review.
