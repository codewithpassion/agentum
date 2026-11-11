# @repo/protocol

The shapes the Worker, the daemon, the computer client and the browser agree on. Each module is its own entry in `exports`, and there is no barrel file.

## Token prefixes

`@repo/protocol/token-prefixes` holds the prefix of every secret and signed token the platform issues. Each kind (`API_KEY`, `RUN_TOKEN`, `A2A_ACCESS_TOKEN` and the rest) knows its current prefix (`ag_<kind>_`) and the one from before the rename (`hm_<kind>_`). New tokens get `issue`. Production still holds `hm_` keys, credentials, share links and connections, so every check accepts both: use `matches`, `strip`, `prefixOf` or `pattern`, never a `startsWith` on one literal.

Three kinds are still issued as `hm_`: `RUN_TOKEN`, `MACHINE_CREDENTIAL` and `ENROLL_CODE`. A client installed before the rename checks those prefixes itself, and does not update on its own. The Rust client (`apps/agentum/src/enroll.rs`) accepts both. The TypeScript daemon and the Go computer client, which knew only `hm_`, are retired. Once every installed Rust client accepts `ag_`, drop the `"legacy"` argument on the three kinds in `token-prefixes.ts` so they are issued as `ag_` too.
