# EP.4 review

Implemented by Codex (gpt-6.1-sol), reviewed by Claude Opus. Claude ran the browser and cold-start checks.

## Round 1 (cf256d3d): must-fix
- Needs you listed pending grants of every user-authored version, so cards piled up.
- An MCP person promoting a run's proposed version with pending grants got `waiting` with no card.
- A read key was offered `artifact_test`, which always failed.
- From the browser check: a person's app showed one plain card per grant with raw ids and no endpoint warning, and approval needed a second promote.
- From the full check: `production-runner.mjs` decoded stdin per chunk, so a multibyte character split across chunks broke the bundle. EP.4's slightly larger bundle exposed it.
- From the cold-start check, description gaps: storage calls, agent ids, model ids, pending grant status, how proxy secrets work for apps, reply statuses and limits, and the example living in the shared `kind` schema.

## Round 2 (9c59e9a9): must-fix
- The same stdin bug in three more runners (it was the cause of the "flaky" `guest-execution` test), and a stale read-key test.

## Round 3 (e0180674): clean, reviewed by the controller; full check, test and build pass with no failures.

## Browser check (moved from EP.2), local dev
Publish over MCP with a write key, approve in Needs you, address shown in Share with Copy, Disable and Rotate. Disable gives 404, Enable 200, Rotate gives 404 on the old address and 200 on the new one.

## Cold-start check
A fresh Sonnet agent with only an MCP client and the goal built a Discord-style bot: Ed25519 verification (a tampered body got 401), PING answered with type 1, `/ping` answered directly, `/ask` handed off with the interaction token as `state` and answered type 5, and `reply()` received the run id and state. The agent's run could not reach a model in the sandbox, so only the `failed` reply was seen live; `scripts/e2e/app-bot.ts` covers `finished` with the fake runtime.

## Follow-ups
- No tool shows a model why an endpoint call or a reply failed, and replies are not retried. A bot builder can't debug "the interaction failed" from MCP.
- A person's artifact test screenshots go to a library path every member can read; the library has no per-person private area.
- `artifact_read` exposes hook URLs to anyone who can open the artifact, while settings need canManage.
