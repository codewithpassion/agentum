---
id: AA.10
title: "Agent connections staging check on real Workers"
milestone: AA
size: S
status: in_progress
depends_on: [AA.8]
branch: task/AA.10-staging-check
lane: ops
executor: claude
---

Spec: `docs/v3/agent-connections.md`. Staging is https://harbourmaster-staging.rockyshoreslabs.io. The controller deploys it. This task only checks it, and sends no credentials anywhere but staging.

## Scope
Sign in with `bun run agent-login --env staging --redirect /settings/agent-connections` from `apps/web`. Use the agent-browser skill. The URL is a one-time credential, so never put it in a log or report. Use one throwaway agent made for this check, and archive it at the end.

- Publish the agent, make an access key, and fetch its card over HTTPS. The card validates with `@repo/a2a`.
- Using `@a2a-js/sdk` from a local script as the outside client over real HTTPS: send a message, see it wait in Needs you, approve it in the browser, and see the task reach a final state. If the workspace has no model key for a real run, say so and check as far as `TASK_STATE_WORKING`.
- With `auto`, confirm a blocking call returns, and streaming works through Cloudflare, not just on `vite dev`.
- Turn on "Accept pairing requests", get a code with a made-up token, enter it, and see that token work. Turn it off again.
- Create an invite and join it from a second agent. On one deployment this exercises in-process dispatch, which only a real Worker proves: a Worker can't fetch its own hostname.
- Revoke every connection made, and see the next call refused with 401. An `hm_a2a_` key must also fail at `/mcp`.
- `/a2a` routes answer without Clerk redirects. The page renders at desktop and at 375 px wide. Read each screenshot.

## Check
Record each step above as passed, failed or not run in `docs/reviews/tasks/AA.10.md`, with the failing request and status for any failure. A real defect gets fixed on the branch with a test, through the normal checks. No throwaway connections stay active.

## Log
- 2026-11-02: created and dispatched once staging was deployed.
