# @repo/protocol

The shapes the Worker, the daemon, the computer client and the browser agree on. Each module is its own entry in `exports`, and there is no barrel file.

## Token prefixes

`@repo/protocol/token-prefixes` holds the prefix of every secret and signed token the platform issues. Each kind (`API_KEY`, `RUN_TOKEN`, `A2A_ACCESS_TOKEN` and the rest) knows its current prefix (`ag_<kind>_`) and the one from before the rename (`hm_<kind>_`). New tokens get `issue`. Production still holds `hm_` keys, credentials, share links and connections, so every check accepts both: use `matches`, `strip`, `prefixOf` or `pattern`, never a `startsWith` on one literal.

Three kinds are still issued as `hm_`: `RUN_TOKEN`, `MACHINE_CREDENTIAL` and `ENROLL_CODE`. Installed daemons and computer clients check those prefixes themselves, know only `hm_`, and do not update on their own. This release teaches the daemon (`apps/daemon/src/config.ts` and the machine schemas here) and the Go client (`apps/computer/internal/enroll/enroll.go`) to accept `ag_`. Once those updated daemons and computer clients have shipped, drop the `"legacy"` argument on the three kinds in `token-prefixes.ts` so they are issued as `ag_` too.
