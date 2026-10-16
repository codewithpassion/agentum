---
id: F.2
title: MCP bash tool over the workspace library
milestone: F
size: M
status: done
depends_on: [F.1, M2.1]
branch: task/F.2-mcp-bash-tool
---

From the just-bash spike (`harbourmaster-wt/tmp/spike-just-bash/REPORT.md`). Draft, not approved.

## Scope

Add `just-bash` (pinned, 3.6.0 or later) to `apps/web` and import it only from `just-bash/browser`. Write a `LibraryFs` adapter that implements its `IFileSystem` over the F.1 service. The spike's `src/r2-fs.ts` is the starting point, but listing and `stat` go through the index instead of R2 `list` and `head`. `stat` returns an `identity`, or `mv` over an existing file fails.

A new MCP tool area `library` with one tool, `bash`. Input: `script` (string, at most 8 KB). Each call builds a fresh `Bash` with a `MountableFs`: in-memory base, library mounted at `/library`, cwd `/library`. The description tells the model that files outside `/library` vanish after the call and that `curl`, `python3`, `sqlite3`, `tar` and `js-exec` are not available.

Limits: the `hardened` profile, `maxExecutionTimeMs` 10 s, `maxOutputSize` 10 MB (it counts redirected writes too), stdout and stderr returned capped at 64 KB each with a "truncated" note, and a budget of 2,000 storage calls per tool call. The adapter counts calls and fails the command with a clear error past the budget.

Every call appends one `library.command` event: the script (through `stripSecrets`), exit code, wall time, storage calls, and the actor (user or agent). Writes inside the script also add F.1's events.

Works for every principal the MCP route already accepts (API key, OAuth, run token).

## Check

`library-bash.test.ts` in `packages/mcp` or `apps/web` with the fake R2:

- `mkdir -p a && echo hi > a/x.md`, then in a second call `cat a/x.md`, `grep -rn hi .`, `sed -i s/hi/ho/ a/x.md` and `ls -R | wc -l` give the expected output;
- `cat ../../other-ws/library/x` fails and touches no key outside the workspace prefix;
- a loop that writes 3,000 files stops at the call budget with a clear error;
- each call adds one `library.command` event.

Live in local dev: an agent with only the platform MCP writes a note with `bash`, a second run finds it with `grep -r`. `bun run build` then `wrangler deploy --dry-run --outdir` reports the compressed size before and after, and the delta is in the log (the spike measured about 410 KB gzip on its own).

## Log
- 2026-10-16: drafted from the just-bash spike.
- 2026-10-16: added from the just-bash spike (docs/reviews/spike-just-bash.md). Dom accepted the defaults: library in Harbourmaster on R2, agents write anywhere, agents may edit their own skills, paid Workers plan, 10 MB per file and 1 GB per workspace, just-bash beta with network, Python and JS off.
- 2026-10-16: dispatched on task/F.2-mcp-bash-tool.
- 2026-10-16: review clean after 1 fix round at c9873b6 (docs/reviews/tasks/F.2.md). Merged. Bundle +484 KiB gzip (1,420 KiB total). Real-agent bash write/grep check to run in the final local smoke.
