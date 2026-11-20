# ME.16 review: the outside-text guard covers every web path

## Verdicts

- Round 1 (72c752a4): not clean, 5 must-fix. `run_skill_script` and the computer desktop tools reach the network with no event. A parent could remember what its subagent fetched. The connector gap was only mentioned, not decided. Machine and managed tool events reach the log after the call.
- Round 2 (4f97f78f, fixes only): not clean, 2 must-fix. Earlier runs in the same session were not checked, and the family reads bound one parameter per run id, over D1's 100-parameter limit.
- Round 3 (0f7eee02, fixes only): clean.

## What changed

`usedWeb` in `packages/services/src/memory/provenance.ts` now reads the events of the run's whole chain (ancestors to the root, then every run below the root). It counts:

- any `network.request`, whatever its `via` (`curl`, `run_script`, `web_fetch`), and any `browser.action`;
- a `tool.call` named `WebFetch` or `WebSearch` (machine, Claude Code), `web_fetch` or `web_search` (Managed Agents, Pi);
- a `tool.call` that can reach the network with no event: `bash` (machine, Managed Agents, cloud Linux VM), `run_skill_script`, `computer_exec` and the desktop tools, matched at the end of the name so `mcp__<server>__` and `<server>_` prefixes match;
- a `tool.call` whose payload went to the blob store, since its row keeps no name.

The shell hold follows the controller's decision of 20 Nov 2026 and extends it to the other tools above, which have the same blind spot. The limits are written in `docs/v4/memory-format.md`.

## Nits left

- `inBatches` runs every events read even after one finds a hit.
- The 120-run test proves the batch boundary, not D1's parameter limit, because the test database has none.
- `desktop_clipboard_get` is not listed: it is a relay op, not an agent tool.
- Pi may shorten or suffix a long tool name, so a suffixed name is missed.
- Claude Code tools that run a command besides `Bash` (`Monitor`, `PowerShell` on Windows) are not listed. The repo does not name them.
- Pi has no `web_search`; the name is listed for Managed Agents only and does no harm in Pi.
- The workspace boundary and a sibling-only hold have no test of their own.

## Ideas beyond the scope

- Tool events from machine and Managed Agents runs arrive in batches or by polling, so a `remember` seconds after a web tool call can apply before the call shows. A fix needs the platform to hold such a note until the run's events are in, or to re-check on ingest.
- Connector (MCP) tools such as Gmail, Slack and documentation search return text from outside. Deciding which connectors count as outside text is a separate task.
- A later run in the same session (a Managed Agents follow-up, or a continuation of a top-level parked run) keeps an earlier run's web text in its context. Holding a whole session after one web fetch would hold every note in a long chat, so it needs a product decision.
- A person's edit or forget of an agent note is not held for outside text; only agent writes are.

## Steps for Dom

- Decide whether the shell hold should stay for Managed Agents, the cloud Linux VM, skill scripts and the computer tools, as built, or cover the machine runtime only as the task text says. Shell-using agents will see their notes held for approval until you decide.
- Decide the three open limits above: late tool events, connectors, and session scope.
