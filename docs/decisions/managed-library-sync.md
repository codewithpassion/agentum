# Managed agents and the library sync helper

Task V4.14, a spike run on 2026-10-26. Question: can a Managed Agents sandbox run a small helper built on `packages/library-sync` that pulls the agent's library scope with its token over HTTPS, keeps running during the session and pushes changes back?

## Decision

The sandbox can run the helper. Harbourmaster cannot use it today, and I do not recommend a resident live-sync helper at all.

The sandbox side passed all four checks in the task: outbound HTTPS, a process that outlives a tool call, disk that outlives a turn, and a way to change a session's tools. The Harbourmaster side fails on authentication. The library routes accept only `hm_run_` tokens, and a managed agent holds an `hm_ses_` token that the routes refuse. Even with that fixed, the session token resolves only while a run is live, and idle sandboxes are stopped after about two minutes, so a background process cannot stay up between turns.

What to do:

1. Build V4.13 as planned. Its tools are `library_list`, `library_read`, `library_write`, `library_versions`, the existing `bash` and the wiki tools. Together they cover reading, writing, versions, grep, sed, awk and jq through the library `bash` (8 KB script, 10 second limit, text output capped at 64 KB) and the task folder (`agents/<slug>/tasks/<runId>/`, a plain library path). Managed agents already get the platform MCP, so they get these tools with no extra wiring.
2. One gap remains, and it needs a new task. A file the agent makes in the sandbox (a PDF, an image, a large CSV) can reach the library only if the model writes its bytes as base64 into a `library_write` call. I did not measure the limit, but a model reproducing bytes in tokens gets slow and error prone well before the 10 MB library cap. The reverse direction has the same limit: sandbox tools (python, bun, `grep` over many files) cannot see library files the model has not pasted in. A one-shot transfer closes this: `pull` at the start of a run, `push` before it ends, both over the library routes. The experiment shows the pieces work. Suggested task, "Managed sandbox library transfer", lane services and mcp:
   - Library routes accept `hm_ses_` tokens through `verifyAgentToken` (`packages/services/src/run-tokens.ts`, already exported), and the route stops requiring the `:id` in the path to match, because the run changes every turn. A session-scoped path such as `/api/session/library/*` is cleaner than loosening `/api/runs/:id/library/*`.
   - `managed/service.ts` `createSession` adds one more environment variable credential holding the session token, limited to the Worker's host, next to the ones it already makes for secrets and the relay (`service.ts:600` and `:607`). The agent then runs `curl -H "Authorization: Bearer $HM_LIBRARY_TOKEN"` and the platform swaps in the real value on the way out.
   - A skill, mounted by the existing Skills API path from M8.3, carries the 14 KB bundled helper with one-shot `pull` and `push` commands, and the managed prompt says when to run them.
   - A live watcher is an option on top, not a requirement. It worked while a turn ran, but it needs the extra work below to be reliable.
3. If the controller prefers to wait, V4.13 alone is a complete answer for text and small files.

## What worked

All runs used a direct Managed Agents session with the `ANTHROPIC_API_KEY` from `apps/web/.env.local`, not the staging Worker. I did not check whether the staging workspace has an Anthropic key. The Worker side was a stand-in: a 100-line Bun server implementing the routes in `packages/protocol/src/library.ts` in memory, reached through a cloudflared quick tunnel. The helper was `packages/library-sync` with a fetch based remote port and a disk local port, about 90 lines, run in the sandbox. The harness scripts live in `/home/roboto/devel/harbourmaster-wt/tmp/V4.14/spike/` and are not committed.

Objects made at Anthropic: environment `env_01XGH3s5BfexiZP3GsLVjQ18` (cloud, `networking: unrestricted`), vault `vlt_011CgQpvdhVdYx1BiaFVKLgh` with one environment variable credential `HM_TOKEN` limited to the tunnel host, agent `agent_01J2bBoD4kVAHZVUXUyqiFq9` on `claude-haiku-5-5` with the standard agent toolset, sessions `sesn_0135vd3FEVgN2T9sRRSpqGzL` (a) and `sesn_014rAKGpbgw74Cf4vq6LboMx` (b). Session usage reported a list cost of 0 for the first turn, and the whole spike was a few dozen short Haiku turns.

Outbound network. From the sandbox, `curl` reached the tunnel and the staging Worker (`https://harbourmaster-staging.rockyshoreslabs.io/api/runs/x/library/list` answered 401, so the request got through). Bun's own `fetch` reached the tunnel too, which matters because the sandbox sets `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` for an intercepting proxy and Bun accepted it. A single HTTPS request held for 80 seconds returned 200 after 80.8 s, so a long poll of that length would work.

Token handling. `echo $HM_TOKEN` in the sandbox printed `ANTHROPIC_SECRET_PLACEHOLDER_<hex>`. A request to the allowed host with `Authorization: Bearer $HM_TOKEN` arrived at the stand-in server with the real value, from `curl` and from Bun's `fetch` alike. The real token never appears in the sandbox, so the agent cannot leak it. I did not verify that the swap is skipped for a host outside `allowed_hosts`, because the Haiku agent refused to send the token to a second host (see below). The consequence is documented behaviour, not tested here: a helper that talks to a second host needs a second credential.

Runtime. The sandbox is x86_64, runs as root, has `bun` 1.4.4 and `/workspace` on a 252 GB disk. The helper ran two ways from files downloaded off the tunnel: `bun helper.js once` with the 14,267 byte bundle, and the 99,309,815 byte binary from `bun build --compile --target=bun-linux-x64`. Both pulled `agents/spike/notes.md` and `agents/spike/nested/deep.txt` correctly. The binary adds nothing over the sandbox's own bun, so ship the bundle.

Process lifetime inside a turn and just after. `setsid nohup bun helper.js watch &` started in one tool call was still running in the next (pid 1276, `etime` 01:50 at 12:15:14, checked in a later turn). A plain `&` survived as well in session b. While session a was idle, `server.log` kept showing the helper polling every 3 to 4 seconds for at least 94 seconds.

Push and pull. A file created in the sandbox at 12:13:30 reached the stand-in library at 12:13:33 through a `PUT` (the helper's log shows `written=["agents/spike/from-sandbox.txt"]` for the cycle ending 12:13:34). A change made on the server while the session was idle (`/put` at 12:15:04, etag `e4`) was pulled at 12:15:06, and the next turn read the new text.

Disk. `/workspace` kept its files across turns and across a sandbox restart: after the restart at about 12:18 the helper log, `library/`, `library.manifest.json` and `bin/` were all there. `/workspace` is per session. Session b's `/workspace` showed none of session a's files, and its processes had different pids, so each session has its own container.

New tools in a running session. The task text says sessions keep their tool setup, and `managed/service.ts` reuses a session only while the agent fingerprint matches (around line 522). That holds for agent changes and not for session changes. Observed:

- `agents.update` on the Anthropic agent (version 1 to 2) did not reach the existing session. `sessions.retrieve` kept showing agent version 1 and the old tool list, and a new session got version 2.
- `sessions.update(id, { agent: { tools } })` worked mid-session. The next turn listed the added custom tool `session_level_tool` among its tools. The SDK documents that only `tools` and `mcp_servers` are updatable, as full replacements.
- `SessionUpdateParams.vault_ids` is "not yet supported" and rejected, per the SDK comment in `resources/beta/sessions/sessions.d.ts`. I did not call it. So a credential reaches a session only through `vault_ids` at creation. Anything the helper needs must be in the vault when the session starts.

## What did not work

Idle sandboxes are stopped. Session a went idle at 12:23:09 (`session.status_idle`) and its helper made its last request at 12:25:03, 114 seconds later. Session b went idle at 12:26:42 and polled until 12:28:06, 84 seconds. A first pair of sandboxes died at 12:18:12 and 12:18:24 in the same way. On the next event the sandbox came back (`uptime` reported `up 0 min`) with `/workspace` intact and no processes. Six messages to session b, one every 34 seconds from about 12:23:56 to 12:26:41, kept its helper polling through that stretch. So a helper lives while a turn runs and for about 1.5 to 2 minutes after, then the next turn must start it again. Managed runs end when the session goes idle, so this fits one-shot `pull` and `push` better than a watcher.

No startup hook. Nothing starts a process when a session is created. The model has to run the command with `bash`. The Haiku agent refused to run commands several times, first a download-and-run of the helper, then any command that sent `HM_TOKEN` to a host that was not the one it had already used, until my message said it was an authorised test. A shipped helper must be started by the managed prompt or a skill, and its start depends on the model following that instruction. Whether a real prompt on the platform's own base URL gets the same caution was not tested.

The routes refuse the managed agent's token, which is the decisive point. I checked it three ways.

- `apps/web/src/server/routes/files.ts:164` `runPrincipal` returns null unless the token starts with `RUN_TOKEN_PREFIX` (line 168), and calls `verifyRunToken` (line 177). `run-library.ts:61` `runRoute` uses it, and line 69 also requires `principal.runId` to equal the `:id` in the path.
- `managed/service.ts:579` signs an `hm_ses_` token and `:591` puts it in the vault. The managed service never makes a run token.
- A throwaway test in `apps/web` (deleted afterwards) signed a session token with `signSessionToken` under the same key and sent it to `/api/runs/r1/library/list`. The route answered 401 `Invalid run token.` The same 401 comes back from staging for `hm_ses_dummy.sig`, `hm_run_dummy.sig` and no header, so that call alone proves nothing. The test above and the code are the evidence.

A session token is also short lived in a way a background helper cannot work with. `verifySessionToken` (`run-tokens.ts:244`) resolves only when the session's `current_run_id` is `running` or `waiting` with a live lease (`:290`, `:301` answers `not_running`). Between runs the helper's requests would get 401.

Live polling costs more than it should. The helper's 3 second cycle makes three to five requests per cycle, since `syncOut` and `syncIn` each walk the tree. For a managed agent that polls all day this is worth replacing with an announce or long-poll route if a watcher is ever built. The 80 second hold above says a long poll fits the sandbox.

## Not covered

The run did not go through Harbourmaster's managed runtime on staging. The refinement says a managed agent on staging needs an Anthropic key on the workspace, and I did not use one. I used a direct session so the check did not depend on a deploy or a workspace key. If the controller wants an end-to-end run on staging, that waits for the follow-up task, because it needs the route change first. A quick tunnel cannot carry server-sent events (a test stream through it returned headers and no body), so push-style announcements were not tried.

Not tested: a second host's token handling, a session older than a few minutes, a session that survives a day, files mounted through the session `resources` field (the Files API can mount a file at a chosen path, which is another way to deliver the bundle without a download), and the conflict path of `syncOut`, which the module's own tests cover.

## Cleanup

The spike's sessions and vault were deleted, the agent archived (the API cannot delete agents) and the environment deleted. `environments.list` afterwards shows no `v414` entry. The stand-in server and the three tunnels were stopped by their pids.
