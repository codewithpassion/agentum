# F.2 review

## Verdicts

- Round 1 (95b1209): must-fix. `chmod` returned ENOSYS, so `cp` and `mv` from scratch (`/tmp`) into `/library` wrote the file but exited 1. The log also lacked the live run and the bundle delta (recorded below).
- Round 2 (8454e97, the fix commit only): clean. `chmod` is now a no-op, with a test that fails if it is put back.

## Checks

`bun run check`, `bun run test` and `bun run build` pass after `git merge main` (F.3 and S.1 merged without conflicts). `library-bash.test.ts` covers the task's four bullets, plus run and read-only principals, truncation, heredoc whitespace, scratch files and the missing commands. `mcp.test.ts` calls `bash` with an API key and a run token over `/mcp`.

Bundle size, `bun run build` then `wrangler deploy --dry-run --outdir -c dist/server/wrangler.json`, same machine:

- Before: 4196.33 KiB raw, 935.63 KiB gzip.
- After: 6311.66 KiB raw, 1419.62 KiB gzip.
- Delta: +2115 KiB raw, +484 KiB gzip. A smoke build that only imported `just-bash/browser` gave the same size, so tree shaking does not shrink it. Under the 3 MB free and 10 MB paid compressed limits.

Live in local dev (vite dev, local D1 and R2, an API key minted straight into the local D1 for the dev user's organisation):

- One call ran `mkdir -p notes && echo live-note-42 > notes/live.md && ls -R`. A second call, a separate shell, ran `grep -r live-note .` and found `notes/live.md`. The log has one `library.command` event per call and the writes' `library.write` events.
- After F.3 came in: opened `/library` as the dev user, opened `notes/live.md`, typed an edit, pressed Save, and `cat notes/live.md` through `bash` showed the edit.
- Not done: a real agent run with only the platform MCP. It needs a daemon and a runtime on a machine (see below). The two-call check above uses the same `/mcp` route with a key.

Logs are in `harbourmaster-wt/tmp/F.2/`: `dry-before.log`, `dry-after.log`, `live1.txt`, `live2.txt`, `live-f3.txt`.

## Nits left

- A no-op `chmod` also succeeds on a missing library path, and `chmod +x` leaves the file at mode 0644, so `./script` fails while `bash script` works.
- When the budget abort or the 10 s limit fires, everything the script printed before is lost (just-bash returns nothing for the aborted exec).
- Error messages name paths without the `/library` prefix, while `pwd` shows `/library`.
- `stripSecrets` redacts a string only when the whole value looks like a secret or a URL with user info. `export TOKEN=...` inside a script is logged as written.
- If `recordCommand` fails after the script ran, the tool returns an error although the writes happened, and no event exists.
- One `echo > file` makes two `library.write` events, because just-bash truncates (empty write) and then writes. A copy into a missing folder creates the folder, where POSIX gives ENOENT.
- OAuth is not exercised with `bash` in the route test, and folder `cp -r` and `mv` from scratch have no test.

## Ideas beyond the scope

- Make `stat` a size check before `read` in the adapter, and skip the first empty write of a redirect, to cut storage calls and events.
- Tell the model in the tool description that `chmod +x` does nothing and to run `bash file`.
- A Durable Object per workspace to serialise `>>` and `sed -i`. Today `>>` retries on an etag conflict, and `>` stays last writer wins.

## For Dom

A real agent check needs your machine: an agent with only the platform MCP writes a note with `bash`, a second run finds it with `grep -r`. Create the agent, give it an API key or run token for `/mcp`, and run the two prompts from the dashboard. The deploy size is +484 KiB gzip over the current Worker.
