---
id: EP.5
title: Keep a person's bot live across updates, and show app errors
milestone: EP
size: M
status: in_progress
depends_on: [EP.4]
branch: task/EP.5-app-versions-and-errors
lane: services
executor: codex
---

Found on staging on 5 Nov 2026, after EP.1 to EP.4. Spec: `docs/v3/app-endpoints.md`.

## Scope
- Bug: a person's `artifact_update` over MCP becomes the current version before `recordVersionGrants` runs (`packages/services/src/artifacts/grants.ts` about line 451), so `carried` is read from the new version itself and is empty. Every update with an unchanged `agentum.json` goes back to pending and the endpoint answers 404 until a person approves again. Carry approvals from the version that was live before this one.
- A person's new version whose grants are not all approved (new host, new endpoint, new agent) must not replace the live version. It stays proposed and the live version keeps serving; approving its grants in Needs you makes it live with no further call. A version whose grants are all carried goes live at once, as now. Run-proposed versions are unchanged.
- The `artifact_update` and `artifact_promote` results and descriptions say which of the two happened, in words for a person over MCP ("approve in Needs you, then check with artifact_read"), not "stop and do not retry".
- App errors: when an app's `fetch` or `reply` throws or the runtime fails, record an `app.error` event with the artifact, version, entry (`fetch` endpoint name, `fetch` page, or `reply`) and the error message cut to 500 characters. Callers still get the fixed 502 body. `artifact_read` returns the last 10 app errors to callers who can manage the artifact, with time, version and entry. Rate-limit the recording so a broken app under load can't flood `events` (at most one per artifact per 10 seconds, plus a count of the dropped ones).

- Staging follow-up A: version changes must never pause or disable app triggers, including versions with pending agent grants or dropped agents. `startRun` checks the live version's approved agent grant. Preserve explicit current-grant revocation. A person can pause and resume an app trigger through `setEnabled` without HTTP proposal approval.

## Check
- Tests:
  - an unchanged manifest update over MCP keeps the endpoint answering 200 and every grant approved;
  - a manifest that adds a host keeps the old version serving until approval, then the new version serves without another call;
  - run-proposed versions behave as before;
  - a throwing `fetch` and a throwing `reply` each write `app.error`, which `artifact_read` returns to the owner and not to a member who cannot manage;
  - the rate limit holds.
- `bun scripts/e2e/app-bot.ts` passes and covers an update with an unchanged manifest.
- Regression tests cover publishing with a pending agent grant then approving and starting a run, version switches dropping an agent, and a person pausing/resuming app triggers (including proposal metadata).
- Run affected packages' tests, `bun scripts/e2e/app-bot.ts`, and `bun run check`; no whole-repo tests or build.

## Log
- 2026-11-05: opened from the EP staging check and dispatched to Codex.
