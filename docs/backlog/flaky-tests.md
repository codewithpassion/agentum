# Flaky tests disabled by FX.7

These tests pass alone and fail only on a loaded machine. Each is `test.skip` with its body intact. To re-enable one, remove the `.skip` and run the command shown from `apps/web`.

- `apps/web/src/server/live-artifacts/guest-execution.test.ts`, "guest execution: HTTP cap/start, durable recovery, signed MCP and suggestions". Miniflare `ECONNRESET`. Run: `bun test src/server/live-artifacts/guest-execution.test.ts`.
- `apps/web/src/server/mcp/library-bash.test.ts`, "a loop that writes 3,000 files stops at the storage call budget with a clear error". Timed out in DR.13's run. Run: `bun test src/server/mcp/library-bash.test.ts -t "3,000 files"`.
