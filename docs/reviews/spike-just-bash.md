# Spike: just-bash for a workspace file library and per-agent skills

16 October 2026. Dom approved this as a spike only. Nothing here touches the Harbourmaster repo. The draft tasks are for Dom to accept, change or drop.

## Short answer

Yes, just-bash runs in a Cloudflare Worker over R2. I ran it in local workerd (wrangler dev 4.151.0 with local Miniflare R2, no account) with an R2 adapter I wrote. Files persisted between requests and after a restart of the dev server. Local dev does not enforce the Worker `limits`.

The catch is storage calls, not the shell. Every filesystem call becomes an R2 call, so recursive commands cost about two calls per file. `grep -r` over 300 files made 603 calls. The paid plan allows 10,000 per request by default, the free plan 1,000 to Cloudflare services. A D1 index of paths removes most of these calls. That is the main design change for a real version.

I recommend building the library in Harbourmaster on its own R2 bucket and keeping The Brain as the knowledge connector.

## What just-bash is

- **Package.** `just-bash` 3.6.0 on npm, from github.com/vercel-labs/just-bash. Apache-2.0. The README calls it beta.
- **How it works.** A bash interpreter written in TypeScript. It parses the script and runs each command as a TypeScript function against a virtual filesystem. There are no processes, no binaries and no VM.
- **State.** Each `exec()` starts with fresh variables, functions and cwd. The filesystem is shared across calls on the same `Bash` instance.
- **Filesystems.** There are four:
  - `InMemoryFs`, the default.
  - `OverlayFs`, copy-on-write over a real directory, Node only.
  - `ReadWriteFs`, a real directory, Node only.
  - `MountableFs`, which mounts other filesystems at paths. Any object that implements the async `IFileSystem` interface can be mounted, which is how the R2 adapter plugs in.
- **Commands.**
  - File commands such as `cat cp ls mkdir mv rm find stat touch tree`.
  - Text tools such as `grep rg sed awk sort uniq wc head tail cut tr diff xargs`.
  - Data tools `jq yq xan sqlite3`, plus `gzip` and `tar`.
  - Shell syntax: pipes, redirects, `&&`, loops, functions and globs.
- **Off by default.** Network (`curl` needs an allow-list), `python3` and `js-exec`. In the browser entry, which is the one a Worker uses, `sqlite3`, `python3`, `js-exec` and `tar` are not available.
- **Limits.** Two profiles, `normal` and `hardened`. They cap call depth, command count, loop iterations (10,000 in hardened), source size, total output, wall time per exec, and output per command (10 MB). The total-output limit also counts redirected writes.
- **Security.** There is no VM isolation, and it runs in the host JavaScript realm. That is acceptable here because the shell only reaches the filesystem we give it and network stays off.

## Evidence from the Worker spike

Everything is in this folder.

- **`src/r2-fs.ts`** is the adapter, about 230 lines. A file at `/a/b.md` is the R2 object `<ws>/library/a/b.md`. A directory is either implicit or an empty marker object `a/`. `readdir` uses R2 `list` with a `/` delimiter, and `stat` uses `head`. Symlinks, hard links and chmod return ENOSYS.
- **`src/index.ts`** is the Worker. It builds a fresh `Bash` per request with an in-memory base, R2 mounted at `/library`, cwd `/library` and the hardened profile.
- **Scripts.** `run-spike.ts` sends the requests, `cpu-bench.ts` measures CPU and `escape-test.ts` tries to leave the workspace prefix. The `evidence-*.txt` files hold their output and `dev*.log` hold the wrangler logs.

### Commands and persistence

- **Request 1** wrote the files with `mkdir -p`, `echo >`, `echo >>`, `printf >` for a SKILL.md, and a `for` loop.
- **Request 2** used a fresh `Bash` and gave the expected output for all of these:
  - `ls -R`, `cat`, `grep -rn`, `grep -rl | wc -l`
  - `sed -n s///p`, `sed -i`
  - `cat *.md | sort | uniq | wc -l`, `find -name`, `head -n`
- **After a restart.** Stopping and restarting `wrangler dev`, then running request 2 alone, found the files still there, including the `sed -i` edit from the first run.
- **Other commands.** `cp`, `mv`, `rm -r`, `jq` and `gzip | gunzip` also work. `ln -s` fails because the adapter refuses symlinks, not because of just-bash.

### Numbers

Wall times are local Miniflare, so real R2 will be slower per call.

| Command | Wall time (local) | R2 calls |
| --- | --- | --- |
| `cat` one file | 2 to 4 ms | 1 |
| `echo > file` | 23 ms | 4 |
| `ls -R` over 9 files | 24 to 38 ms | 43 |
| `grep -rn` over 9 files | 19 to 31 ms | 30 |
| `grep -rl` over 300 files | 226 ms | 603 |
| `ls` of a 300-file folder | 8 ms | 7 |
| writing 300 files in a loop | 6.3 s | 1,203 |
| building an 8 MB file | 2.0 s | 229 |
| `tail -c 5` on 8 MB | 179 ms | 2 |

CPU is an estimate, measured in Bun against a fake bucket. Bun's engine differs from workerd's.

- Simple commands took 0.4 to 1.2 ms.
- `find` over 300 files took 10 ms, and `grep -rl` over 300 files took 19 ms.
- The first `Bash` plus its first exec took 17 ms.
- The first request took 270 ms wall in total, under the 400 ms startup limit.

That is fine on the paid plan. On the free plan's 10 ms CPU, a recursive grep over a few hundred files would fail.

### Bundle size

- **Spike Worker.** 1,754 KiB raw and 407 KiB gzip, from `just-bash/browser` (`wrangler deploy --dry-run`).
- **`nodejs_compat`.** The size is the same with or without it. `node:zlib` is the only Node import left, and `gzip` worked even without the flag. `apps/web` already sets the flag.
- **Limits.** Workers allow 3 MB compressed on free and 10 MB on paid.
- **The app's current size.** No clean number yet, because `apps/web/dist/server` holds 777 files from old builds. F.2 measures the real increase.

### Gaps found

- **Storage calls.** Recursive commands make about 2 R2 calls per file, and a small write makes 4. The paid limit is 10,000 per request by default and can be raised to 10 million with `limits.subrequests` (Workers limits page and the 11 Feb 2026 changelog). The free plan allows 1,000 calls to Cloudflare services. The Sandbox SDK page still says 1,000 for paid, which is out of date.
- **Concurrent writers.** 10 parallel `echo >> race.txt` requests left one line. `>>` and `sed -i` read the whole file and write it back, and R2 keeps the last write. A retry loop using `put` with `onlyIf: { etagMatches }` fixes this. Plain `>` stays last-writer-wins, as on a normal disk.
- **Partial reads.** `readFile` returns the whole file, so `head` and `tail` can't use R2 range reads. `tail -c 5` on 8 MB read all 8 MB.
- **Large files.** 8 MB worked. 16 MB hit just-bash's 10 MB per-command output limit. `maxOutputSize` also limits redirected writes, so it caps file size per call.
- **`mv` onto an existing file.** It failed until `stat` returned an `identity`. That was a one-line fix in the adapter.
- **Writes outside `/library`.** They land in the in-memory base and are gone after the call. Escape attempts such as `../../wsB` never touched an R2 key outside the workspace prefix. Keep the in-memory base as per-call scratch space and say so in the tool description.
- **Local proxy error.** One request in the load test failed with "Network connection lost" in wrangler's local proxy (`dev2.log`) and passed on retry.

### How much work a real adapter is

The spike adapter took about an hour. A real one needs four changes:

1. **A D1 index of paths** (path, size, mtime, etag, kind), shaped like the `files` table from M7.1. `ls`, `find`, `stat` and the folder walk of `grep -r` become database queries. Only file reads and writes then reach R2. This is the biggest change.
2. **Etag-checked writes with a retry** for `>>` and `sed -i`. A Durable Object per workspace that runs writes one at a time would be cleaner, but it is a bigger step for later.
3. **A 10 MB cap per file**, with no range reads.
4. **A storage-call budget per tool call** that stops with a clear error.

## Design: workspace file library

- **Storage and roots.** One library per workspace, in the `FILES` bucket under `${workspaceId}/library/`, with the D1 index. The folders are conventions, not permissions: `/skills/<agentId>/`, `/skills/_shared/`, `/agents/<agentId>/` and `/outputs/<agentId>/`. Any user or run in the workspace can read and write everything, per "keep permissioning to a minimum". The rule is one function, so per-agent roots can come later.
- **The `bash` tool.** A new MCP tool on `/mcp`, so it works with API keys, OAuth and run tokens. Separate `read_file` and `write_file` tools are left out because `cat` and heredocs cover them.
- **Limits per call.** Each call gets a fresh `Bash` with the hardened profile, 10 s, 10 MB of output, 64 KB returned per stream, and a budget of 2,000 storage calls.
- **Audit.** Each call adds a `library.command` event with the script (secrets stripped), exit code, time and call count. Each write or delete adds a `library.write` or `library.delete` event.
- **Browse page.** A `/library` page with a folder list, text view, upload, new folder, delete, and a text editor that saves with the etag it loaded.
- **Library and runs.** Attaching a library file to a run copies the bytes into a new `files` row. The daemon doesn't change, and a later edit doesn't change a past run. "Save to library" on an output chip copies the other way.

## Design: skills per agent

- **Where skills live.** At `/skills/<agentId>/<skill>/SKILL.md` plus helper files. `/skills/_shared/` holds skills for every agent, and an agent's own skill wins when the names clash.
- **Sync before each run.** The daemon fetches the agent's skills with the run token and writes them to `<workDir>/.claude/skills/`. The sync runs after `prepareWorkDir`, which already empties `.claude/` each run, and before `buildOptions`.
- **No SDK change.** `settingSources: ["project"]` already loads `.claude/skills/`.
- **hm-agent machines.** `WorkFiles.write` goes through the existing `dd` sudo rule, so no new sudo rule is needed. Single-user machines use `node:fs`.
- **Failure.** A failed sync logs a warning and the run goes ahead without skills.
- **Editing.** A Skills tab on the agent page reuses the library editor, and agents can also edit skills with `bash`. Both check the SKILL.md frontmatter.

## The Brain's vault as the alternative

- **For the library.** The `bash` tool would need a WebDAV adapter, with a PROPFIND per directory and a GET or PUT per file. That is at least as many calls as the R2 spike, plus a hop to another Worker. No mapping exists today from a Harbourmaster workspace to a Brain tenant, or from Harbourmaster principals to the vault's Basic credentials. Commands would not land in Harbourmaster's events table. This path was not tested. Its upside is Obsidian sync and Brain ingest of the same files.
- **For skills.** The daemon can fetch skills over WebDAV just as easily, so skills alone don't decide between the two.

## Recommendation

Build the library in Harbourmaster on R2 with a D1 index (F.1 to F.4), with skills on top of it (S.1, S.2).

- **Auth and audit.** The `bash` tool then runs under Harbourmaster's own principals and logs to its own events table. That is the audit trail the vision asks for.
- **Proven path.** The R2 path works in a Worker. The WebDAV path is untested and has to do at least as many calls.
- **Existing parts.** The `FILES` bucket, the M7.1 files service, the MCP tool registry, `WorkFiles.write` and the `.claude/` reset already exist.
- **The Brain's role.** It stays the knowledge connector for `think`, `recall`, `memory_*` and its wiki. Copying library files into the vault for Obsidian could be a small later task.

This changes the architecture's "Deferred" row, which planned the shared wiki on The Brain.

## Open questions for Dom

1. Should the library live in Harbourmaster on R2, or in The Brain's vault? Everything else depends on this.
2. Should agents write the whole library, or only their own `/agents`, `/skills` and `/outputs` folders?
3. Can agents edit their own skills, or only people?
4. Is the paid Workers plan a given? On the free plan, `grep -r` over a few hundred files fails.
5. Are 10 MB per file and 1 GB per workspace the right caps?
6. Is beta software with no VM isolation acceptable for an agent tool, with network, Python and JS turned off?

## Draft tasks

Full text is in `tasks/`. All are `status: todo` and each has its own Check section.

| Task | Size | Depends on | What it does |
| --- | --- | --- | --- |
| F.1 Library service | M | M7.1 | R2 storage, D1 path index, path rules, etag writes, write and delete events |
| F.2 MCP `bash` tool | M | F.1, M2.1 | The adapter over the service, limits, call budget, `library.command` event, bundle size check |
| F.3 Browse page | S | F.1 | tRPC router and the `/library` page with an etag-checked editor |
| F.4 Library and runs | S | F.1, F.3, M7.2 | Attach from the library by copying bytes, and save an output to the library |
| S.1 Daemon skills sync | S | F.1, M1.6, M1.9 | Run-token skill routes and the daemon sync into `.claude/skills/` |
| S.2 Skills tab | S | S.1, F.3 | Skills tab on the agent page and frontmatter checks |

Build order: F.1 first. F.2 and F.3 can run in parallel after it, then F.4. S.1 needs only F.1.
