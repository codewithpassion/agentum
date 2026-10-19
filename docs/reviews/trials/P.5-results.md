# P.5 agent-loop trial, staging (version 50891196)

Run on 19 Oct 2026 against the staging Worker with the workspace's OpenRouter key. Cloud agents, isolate environment, one agent per model, three runs each (nine runs), every run in a fresh session.

## The task

One prompt for every run (`prompt.tpl`). Six keys, one tool call per turn: activate the skill `p5-loop`, read its `reference.md`, read `input.txt` from the library, then for each key call the MCP tool `p5_lookup` (a stub server behind a quick tunnel), run `scripts/checksum.ts` with the key, the returned value and the running total, and edit `results.txt` in the library. At the end write `p5-output.txt`. A correct run makes at least 22 tool calls and writes `P5-DONE-57515` (the value is precomputed in `expected.txt`).

A run counts as a success when its status is `done`, `p5-output.txt` holds `P5-DONE-57515` and no key in `results.txt` is still PENDING. The task file removes a model that fails two of three runs.

## Per run

| Model | Run | Status | Tool calls (turns) | Failed tool calls | Malformed tool calls | Wall time | Output marker |
|---|---|---|---|---|---|---|---|
| GLM-5.3 | 1 | done | 22 (22) | 0 | 0 | 55.3 s | yes |
| GLM-5.3 | 2 | done | 22 (22) | 0 | 0 | 54.9 s | yes |
| GLM-5.3 | 3 | done | 22 (22) | 0 | 0 | 39.2 s | yes |
| GLM-5.3 Flash | 1 | done | 22 (22) | 0 | 0 | 32.1 s | yes |
| GLM-5.3 Flash | 2 | stopped | 132 (132) | 0 | 128 | 240.3 s | no |
| GLM-5.3 Flash | 3 | done | 22 (22) | 0 | 0 | 39.7 s | yes |
| DeepSeek V4.1 Flash | 1 | done | 23 (23) | 1 | 0 | 63.5 s | yes |
| DeepSeek V4.1 Flash | 2 | done | 22 (22) | 0 | 0 | 61.2 s | yes |
| DeepSeek V4.1 Flash | 3 | done | 23 (23) | 1 | 0 | 36.6 s | yes |

Failed tool call means a tool result with `ok: false`. Malformed means a call that left out a required argument. Turns are the distinct model responses that made tool calls, so they equal the tool call count here: no model made parallel calls.

## Verdicts

| Model | Successful runs | Verdict |
|---|---|---|
| GLM-5.3 | 3 of 3 | keep |
| GLM-5.3 Flash | 2 of 3 | keep, with a warning (below) |
| DeepSeek V4.1 Flash | 3 of 3 | keep |

No model fails two of three runs, so the catalogue stays as it is.

## Notes

- GLM-5.3 Flash run 2: from the first checksum step the model called `run_skill_script` without the `args` array, 128 times in a row, and said in its own text that it was adding them. The tool accepts a call with no args (the field is optional) and returns `key= chk=0 total=0`, so nothing flags the mistake and the loop does not end. I stopped it after 240 s by removing the OpenRouter key on the Settings page; the run then failed with the missing-key message, which is the only reason it ended. Runs 1 and 3 of the same model passed the same step. The platform has no turn limit, wall-time limit or repeat-call guard for a cloud run, and no cancel button in the app.
- DeepSeek V4.1 Flash read `reference.md` through `read_skill_resource` with a bare path in runs 1 and 3, got "Not found", and corrected itself on the next call.
- Cost and cache read share: the Log, the session transcript and the run API do not show usage or cost (`runs.usage` is only in D1), and I did not query OpenRouter's activity page. Not recorded.
- A first attempt used a skill created through the older per-agent skills call. The run-time catalogue ignored it ("Skill not found"), so those runs are discarded (`invalid-setup-r0/`). A second attempt reused the first session keys, so the agents saw the old failed conversation (`pilot-contaminated-session/`); those three runs also passed. The nine runs above use fresh sessions and the skill from the skill store, assigned to each agent.
- Logs: `*.transcript.json` (the full session transcript per run) and `*.summary.json` in this folder. `analyze.ts` produced the counts.
