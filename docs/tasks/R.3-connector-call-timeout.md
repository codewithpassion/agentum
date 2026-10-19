---
id: R.3
title: Connector call time limit, and the first of parallel connector calls hanging
milestone: R
size: M
status: in_progress
depends_on: []
branch: task/R.3-connector-call-timeout
---

Asked for by Dom on 19 Oct 2026. Two runs of the isolate agent YT-Synced on staging (DeepSeek V4.1 Flash via OpenRouter) hung with "Running" and never moved on:

- Run 01M59HHNAMC8CVW53YCZZHK045: at 07:38:25 the model made three parallel calls, `the-brain_wiki_list_pages` (first), `the-brain_list_documents` and `read`. `read` and `list_documents` returned within a second. `wiki_list_pages` never wrote a `connector.call` event or a `tool.result`.
- Session 01M59J4SSZQYHMDEBM0JE4337R: at 07:49:11 the model made four parallel `the-brain_search` calls. The second, third and fourth returned within two seconds. The first (`toolu_016NFzcZFwbnqaZmeHTPZBof`) never wrote a `connector.call` event or a `tool.result`.

In both cases the first of several parallel calls to the same connector never resolved, and the run waits for it with no time limit. That points at our connector client (session setup, a shared request id, a lock, or response routing when calls overlap), not at a slow server.

## Scope

- Find and fix why the first of several parallel calls to one MCP connector in a run never resolves. Reproduce it in a test with a fake MCP server that answers overlapping calls, including the first call of a fresh session. Write the failing test first.
- Time limit: every connector tool call has a time limit, default 60 s, settable per connector (10 to 300 s) on the connector's settings. On timeout, abort the request and return an error result to the model ("the-brain search timed out after 60 s. Try a smaller request or retry."), and write a `connector.call` event with outcome `timeout`. The run carries on.
- Apply the same time limit to built-in tools that call out (web_fetch already has 30 s; check the library tools and skill scripts have one, and add one where missing).

## Check

- Tests: four overlapping calls to a fake connector, including the first call of the session, all resolve; a call slower than the limit returns the timeout error and a `timeout` event, and the run continues to its next model turn; the per-connector setting is validated and used.
- `bun run check && bun run test && bun run build` pass.
- Live on staging (controller): an isolate agent makes four parallel calls to the Brain connector, and all four return.

## Log
- 2026-10-19: added at Dom's request. dispatched.
