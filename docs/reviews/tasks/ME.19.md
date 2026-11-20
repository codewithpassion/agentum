# ME.19 review: the outside-text guard catches late tool events and connector text

## Verdicts

- Round 1 (76e5f354): not clean, 1 must-fix. The ingest hook fired only on `tool.call` batches, so a `network.request` or `browser.action` that a tool writes while it runs, after its `tool.call` batch, did not hold an earlier note.
- Round 2 (3bb072e7, fix only): clean. The hook also fires on `tool.result` batches.

## What changed

Connector (MCP) calls count as outside text. The signal is the connector proxy's `connector.call` event, not the per-runtime `tool.call` rows. Machine, Managed Agents and cloud runs all reach connectors through `/api/proxy/<connectorId>` with the run's token (a managed session token resolves to the current run), so the proxy writes one event per call at the call. The tool call rows cannot tell: Managed Agents keep only the bare tool name, Pi renames and cuts the name, and a machine's `mcp__harbourmaster__` prefix is the platform's own server. `usedWeb` counts a `connector.call` with `outcome: ok` and `method` of `tools/call`, `resources/read` or `prompts/get`. Handshake and listing calls, and refused, denied or failed calls, do not count.

Late events: `holdAfterOutsideText` in `packages/services/src/memory/service.ts` moves the applied agent notes of a run's chain back to held when the chain has used outside text. It puts the file back as undo does, sets the `memory_changes` row to `held` with no library version and no decision, and the usual Needs you card appears. It runs after `ingestRunEvents` stores a batch with a tool call or result, and in the proxy after an answered connector call. It skips notes a person approved, dream and merged rows, team rows, and notes a person changed since. A failing hook is logged and never fails the ingest or the call.

## Nits left

- `holdAfterToolCall` in `runs.ts` is named for tool calls but also fires on tool results.
- The hook adds a chain walk and an events query to most ingest batches and to every answered proxy call, including `initialize` and `tools/list`. A method check in the proxy would skip those.
- `runFamily` runs twice per hold, once inside `usedWeb` and once directly.
- A JSON-RPC batch body, or one with ambiguous keys, records `method: null` and so never counts as a connector answer. `completion/complete` is not counted either.
- The library history shows the agent reverting its own note, and nothing marks a re-held row as different from one held at write time.
- A non-service error on one row stops the loop and leaves the later notes applied. The caller logs it.
- No test covers the row filter's exclusions (dream, merged, team rows), and the proxy tests stub the hold instead of running it with the memory service.
- A held edit of a note that a hold also took out of memory can only be approved after the note's own add is approved.

## Ideas beyond the scope

- Hold the whole session after outside text, which stays a product decision (session scope is unchanged).
- Mark a note held by a late event with its reason on the Needs you card.

## Steps for Dom

None.
