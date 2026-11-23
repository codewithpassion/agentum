# FX.5 review

Round 1 at 1946697c: clean, no must-fix.

## Cause

The runner's pooled keep-alive socket. After a slow request (a durable-object alarm replay can take 5 to 8 s on a loaded host), workerd closes the idle pooled socket just as the next request is written to it, which fails with `ECONNRESET`. The cause is inferred from the failure shape and FX.1's findings, not reproduced, because load generation is forbidden.

## Fix

- `guest-execution-runner.mjs`: `open()` sends `Connection: close`, so each request uses a fresh connection and no pooled socket can go stale. The reviewer confirmed in the installed undici and Miniflare code that the header makes undici set `reset` and not reuse the socket.
- Removed the `.skip` and its `biome-ignore` from `guest-execution.test.ts`, and the entry from `docs/backlog/flaky-tests.md`. No assertion changed and the 240 s timeout stays.

## Checks

- `guest-execution.test.ts` passes 5 of 5 times alone (78 to 108 s).
- `bun run check` and `turbo run test build` on the changed package (web: 5479 pass, 0 fail) pass.
- No browser steps in the task's check, none skipped.

## Nits left

- The FX.1 comment above `request()` (unread bodies destroy the pooled socket) is now moot, since no socket is pooled. Draining bodies is harmless.
- The new comment in `open()` states the cause as fact, but it is inferred.

## Beyond scope

- `guest-runner.mjs` (line 82) uses the same pooled `dispatchFetch` pattern without `Connection: close` and could flake the same way.

## For Dom

None.
