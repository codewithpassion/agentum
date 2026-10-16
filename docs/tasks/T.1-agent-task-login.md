---
id: T.1
title: Agent Task sign-in script per environment
milestone: T
size: S
status: in_progress
depends_on: [O.1]
branch: task/T.1-agent-task-login
---

Asked for by Dom on 17 Oct 2026. The staging smoke test stopped at Clerk's new-device code (client trust), which stays on. Clerk's Agent Tasks (beta, `clerkClient.agentTasks.create()` in `@clerk/backend`, docs https://clerk.com/docs/guides/development/testing/agent-tasks.md) return a one-time URL that signs a user in without the sign-in screen. Browser tests and agents use it to sign in on a deployed environment.

## Scope

A script in `apps/web/scripts/`, run as `bun run agent-login` from `apps/web`, that prints one Agent Task URL for a user on a chosen environment:

- `--env local|staging|preview|production` (default `local`), `--pr <n>` for preview, `--email <address>` (default `DEV_LOGIN_EMAIL` from `.env.local`), `--redirect <path>` (default `/`).
- Base URLs: local `http://localhost:3000` (or `--base-url` to override for any env), staging `https://harbourmaster-staging.rockyshoreslabs.io`, preview `https://pr-<n>-harbourmaster-staging.dominik-fretz.workers.dev`, production `https://harbourmaster.rockyshoreslabs.io`. The redirect URL is the base URL plus the path.
- Clerk secret key: local, staging and preview use the Clerk dev instance, so `CLERK_SECRET_KEY` from `apps/web/.env.local`. Production reads `CLERK_SECRET_KEY` from `apps/web/.env.production.local` (gitignored) or the process environment, and fails with a clear message when neither has it. Never print or log the key.
- Calls `agentTasks.create({ onBehalfOf: { identifier: email }, permissions: '*', agentName: 'harbourmaster-agent-login', taskDescription, redirectUrl })` and prints only `agentTask.url` on stdout. Errors go to stderr with a non-zero exit.
- The app lands on its signed-in pages only when the session has an allowed organisation active. Find out whether a session from an Agent Task has one. If it doesn't, make the landing work for the dev user without changing auth rules for anyone else, and say how in the review file.
- Pure helpers (argument parsing, env to base URL and key source) live apart from the Clerk call so they can be unit tested.
- Document the script in `CLAUDE.md`: a short "Agent Task login" section next to "Dev login (testing)" saying what it does, the command with its flags, that the URL is a one-time credential (don't paste it into logs or reports), and that it's how agents sign in on staging, preview and production. Mention it in `apps/web/README.md` where dev login is described.

## Check

- Unit tests for the helpers: each env's base URL, `--pr` required for preview, the key source per env, and the production error when no key is found.
- Live: `bun run agent-login --env staging` prints a URL. Opening it in a fresh browser session lands signed in as the dev user on a signed-in staging page (the agents list), with no Clerk sign-in screen or device code. Don't print the URL in reports.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-17: added at Dom's request; dispatched on task/T.1-agent-task-login.
