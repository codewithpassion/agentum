# TM.17 review

Task: pass the compaction setting to Claude Code on machines.

## Verdicts

Round 0 (commit d67ae3f3): clean. No must-fix findings.

The flag's name and syntax were checked against the installed Claude Code 2.1.327 (`claude --help`): `--autocompact <auto|tokens>`, tokens at least 100k. The three budgets map to 100k, 200k and 500k, so every value is valid.

## How it works

The daemon reads the Claude Code version once, in `AgentHost::prerequisites`, and stores whether it is 2.1.327 or newer. A run passes `--autocompact <tokens>` only when that flag is set and the agent's `runtimeConfig.contextBudget` is small, standard or large. An unreadable version counts as too old.

## Nits left

- No test covers `prerequisites` setting `host.autocompact`. The argv test sets it by hand.
- `context_tokens` in `apps/agentum/src/runs/helpers.rs` copies `CONTEXT_BUDGET_COMPACTION_TOKENS`. A comment links them, but the parity fixture does not check the values.
- The `supports_autocompact` assertions sit in `typescript_helper_parity`, which has no TypeScript counterpart for them.

## Ideas beyond the scope

- Add the budget table to the parity fixture so the Rust and TypeScript values cannot drift.

## Steps for Dom

None.

## Notes

- `desktop::apps::tests::the_session_bus_listens_where_the_environment_says` fails on machines where the temp path is too long for a D-Bus socket. It is not caused by this change.
- On this machine `cc` on PATH is a Command Centre shim. Run Rust through `apps/agentum/scripts/cargo.sh`, which `bun run test` already does.
