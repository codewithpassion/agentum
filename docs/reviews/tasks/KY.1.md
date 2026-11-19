# KY.1 review

## Verdict

Round 1, commit 3eb56386: clean. No must-fix findings.

## Nits left

- `packages/services/package.json`: the `./keys` export sits after `./live-artifacts/ticket`. Alphabetically it belongs after `./investigator-report`.
- `packages/services/src/catalog.ts`: `list()` returns a plain array while `add` and `keys.forAgent` return promises. If the catalogue service reads the database, `list` becomes async and the router line changes with it.

## Beyond the scope

- `connectors.catalog_key` is written as null by `connectors.create`. The catalogue service task sets it when `catalog.add` creates a connector.
- The `AgentKeys` parts are shaped from the current tables (agent_connectors, credentials, secrets, a2a connections, `hands_to`, `ask_level` and `agent_tool_rules`). The Keys service task may find a field it wants and should then change the type in one place, `@repo/db/shared`.

## Test notes

- `live-artifacts/guest-execution.test.ts` is flaky on this host (miniflare "other side closed"), already recorded in `docs/reviews/tasks/NV.1.md`.
- The Rust test `the_session_bus_listens_where_the_environment_says` fails in a long worktree path (D-Bus socket path length). Both are unrelated to this task.

## Steps for Dom

None.
