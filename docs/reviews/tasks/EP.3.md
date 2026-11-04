# EP.3 review

Implemented by Codex (gpt-6.1-sol), reviewed by Claude Opus.

## Round 1 (6ae54493): must-fix
- An app's sessionKey was stored raw, so two apps handing off to one agent with the same key shared a session.
- The app's `reply` ran inline and unbounded inside run completion and the events listener.
- Rejecting an agent grant on a superseded version paused the live trigger.
- The local end-to-end check in a real dev server needs EP.2's route. It moved to EP.4's `scripts/e2e/app-bot.ts`.

## Round 2 (3d7bce15): must-fix
- The cron, email and queue handlers and ManagedPoller composed with no defer, so deferred replies from reap, sweep and managed runs were dropped.

## Round 3 (5abb6e7b merge of main with EP.2, 67aa616f fixes): clean

## Nits left (for EP.4)
- `claimGrantsStatement` in `packages/db/src/artifact-grants.ts` has no callers since the merge inlined it in `grants.ts`.
- The merge put back the old doc comment on `Atomic` in `packages/db/src/atomic.ts`, and the `"all" in statement` check there is redundant.
- Endpoint and reply viewers refuse viewer storage by two mechanisms in `app-host-core.ts`.
- A missing run row drops a reply with no trace (`replies.ts:103`).
- The defer guard in `exports.test.ts` accepts any arrow function.
- A wake run (`a2a/outbound.ts` startWakeRun) copies an app reply target, so the app's `reply` can be called again with the same state. Probably right, but untested and undocumented.
