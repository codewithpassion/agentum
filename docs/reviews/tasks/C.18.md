# C.18 review notes

Keep a script's output when it hits its time limit. Branch task/C.18-script-timeout-output.

## What was built

When `run_script` or a skill script stops at the wall limit, the result now carries what the script printed. The Dynamic Worker harness keeps the current run's stdout and stderr streams at module level and exposes them through a second entrypoint method, `Runner.output()`. When the sandbox's wall timer wins the race, or the CPU limit rejects the run, it asks the same loader stub for `output()` (waiting at most 1 s) and returns exit code 124 with that stdout, the script's stderr and then the timeout line. The caps are the existing ones, applied by `describeResult` and `describeRun`.

The output is pulled by the caller, not pushed by RPC callbacks from the isolate, so it costs the script none of its 50 subrequests.

The VM sandbox already returned partial stdout and stderr on a timeout. It put the note first; it now puts it after the script's stderr, so both backends read the same.

`local-worker-loader.ts` (test stand-in) now exposes any entrypoint method, not only `run`.

## Why run 94TVF8QX hung (scope item 2)

Not found, and no code change was made for it. The leads, none confirmed:

- The web fetcher's own per-request timeout is `WEB_FETCH_TIMEOUT_MS` = 30 s, the same as the run limit. One slow host in a 60-fetch script is enough to run the script out of time, and then the fetch is still pending when the wall timer fires. This fits the symptom best.
- The 50-subrequest limit applies to calls the isolate makes. Whether the 51st `HOST.send` rejects or waits on workerd is unverified (C.17's review noted the same). If it waits, 60 fetches would hang the way the run did.
- `ScriptHost` runs `compose()` on every RPC call, which adds latency per fetch, but not a hang.

Three reruns finished in about 4.5 s, so a transient slow host is the likeliest cause. With this task in, the next occurrence returns the lines printed before the stop, which shows how far the script got.

## Verdicts

Round 1 at 003d54d: not clean. Three must-fix items. (1) The hang finding had no record: answered by the section above. (2) The tests hung on a never-settling promise, and the task asks for a script that loops past the limit: the three tests now loop on a 10 ms timer, and a test for the CPU-limit branch was added with a stub loader. (3) The assumption that a second RPC on the same `loader.load` stub reaches the same isolate and can answer while `run()` is pending is only tested with the bun stand-in: left as a staging check for Dom (below). Also fixed from the nits: the file header comment and the `then` key on the stand-in's entrypoint proxy.

Round 2 at e431609: clean.

## Nits left

- A script with more than 64 KB of stderr loses the `timed out after` line, because the output cap keeps the head. Exit code 124 still shows. The VM backend used to put the note first, which avoided this.
- `vm-skill-sandbox.ts` ends the note without a newline, the dynamic backend with one. Both predate this task.
- The stand-in loader's `output()` call runs `putBack(saved)` while the timed-out `run()` still runs in the same process. Harmless now.
- The three loop tests leave a 10 ms timer running until bun exits, because the stand-in runs scripts in-process.
- The CPU-limit test uses a hand-built loader stub, since a real busy loop cannot run under bun.
- A busy synchronous loop on workerd cannot answer `output()`, and after the CPU limit the isolate is probably gone. In both cases the sandbox waits 1 s and returns only the timeout line, as before. The fix helps awaiting scripts (the observed case), not CPU-bound ones.

## Ideas beyond the scope

- A per-fetch timeout in the harness `fetch` shorter than the run limit, so a slow host fails one call and the script can print and exit.
- Count `HOST` calls in the harness and fail the 51st with a clear message instead of relying on workerd's behaviour.
- Reserve room for the timeout line when stderr hits the cap.

## Steps for Dom

On staging, with an isolate agent: run `run_script` with code that prints three lines and then awaits a promise that never settles. Expect exit code 124, the three lines, and `timed out after 30 s` on stderr. This confirms that `output()` reaches the same isolate on real workerd while `run()` is pending. If only the timeout line comes back, the isolate is not shared and the harness needs another way to hand its output out. Then try 60 parallel fetches to see what the 51st call does.
