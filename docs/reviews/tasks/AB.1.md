# AB.1 review

An ask level per agent, with grouped overrides.

## Verdict

Clean after 1 fix round.

## What changed

Agents have `ask_level` (`rarely`, `outside`, `everything`, `custom`). The level asks about every action it covers, connector tools added later included, and `agent_tool_rules` rows are overrides on it. Migration 0051 adds the column with default `rarely` and marks every agent that has rows as `custom`, so nothing changes for them. Agents without rows read `rarely`, which asks about none of the listed actions, so they run as before.

- `rarely` and `custom` ask about nothing by themselves. `outside` asks before every connector tool, `web_fetch` and `harbourmaster/send_message`. `everything` asks before every gateable action. `levelAsks` in `agent-profile/ask-before.ts` holds the rule.
- `send_message` and `start_subagent` are gateable actions with keys `harbourmaster/send_message` and `harbourmaster/start_subagent`.
- `askKeysOf` (`requests/ask-keys.ts`) applies the level and the rows together, so cloud, VM, managed and machine gate from the same list the card shows.
- `setAskBefore` refuses a key that is not one of the agent's gateable actions (code `invalid`), for the card and `set_agent_ask_before`. A switch that agrees with the level removes its row, one that disagrees writes `ask` or `allow`. `setAskLevel` keeps the rows.
- tRPC `agentProfile.askLevel` and `agentProfile.setAskLevel`. The card shows the three levels, a Customise button, and the switches grouped by source (built-ins, one group per connector) with a group switch and "n of m ask". Identical covers lines show once per group.

## Review rounds

Round 1 at e3f82c51: not clean. One must-fix: `harbourmaster/send_message` starts work on another agent or a peer, not a message to a person, and `rarely` asked about it, which changed how every agent without rules ran. Fixed in 2fda928a: `rarely` asks about none of the listed actions, `send_message` moves to `outside` and is labelled "Send a message to another agent".

Round 2 at 2fda928a: clean, three nits.

## Nits left

- The `rarely` case in `agent-profile.test.ts` checks the card, and no test asserts `askKeysOf` is empty for a `rarely` agent with a connector.
- The "custom" test sets the level by hand. The migration itself is covered by `packages/db/src/ask-level-migration.test.ts`.
- `askKeysOf` loads the agent's connectors for `rarely` too, then filters every action out. Short-circuiting it like `custom` saves a query per gate.
- `assignedConnectors` in `ask-keys.ts` copies the query in `connectors.agentTools`. If one changes alone, card and gate drift apart.
- A tool the upstream server adds after the last connector refresh runs ungated at `outside` and `everything`, because only stored tool lists are gated. The card does not list it either.
- `requests.rules.set` still accepts any key. No UI calls it for ask switches.
- Two connectors with the same name land in one group.
- `get_agent` and the MCP tools do not show or set the level.
- The covers lines sit at the top of the Built-in tools group, not under each switch.

## Ideas beyond scope

- An MCP tool to read and set the ask level.
- Gate `slack_send` and `inbox_post`, which reach people and are not gateable actions.

## Not verified

- No browser check of the card against a local dev server, and no staging check. The card is covered by the pure grouping tests and the service and router tests.
- `bun run test` failed once under heavy machine load in `guest-execution.test.ts` (a Miniflare socket error) and once in a timing test, and both passed alone and on rerun.

## Steps for Dom

- The level names and what each asks about are my reading, because the task leaves them open: Rarely asks about nothing extra, Outside adds connector tools, web fetch and agent-to-agent work, Everything asks about every listed action. Say if you want a different split.
