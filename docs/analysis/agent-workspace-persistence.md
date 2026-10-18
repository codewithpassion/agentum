# Agent workspace persistence

Analysis for Dom, 18 Oct 2026. Read-only: no code, D1, R2 or secrets were touched.

Dom's report: on staging, files an agent writes don't survive into its next session. Dom wants three areas in every agent's environment. The first is a per-agent home that persists across that agent's sessions. The second is a scratch folder that is gone after the session. The third is a folder shared by all agents and sessions, which is the library. Each agent's system prompt should explain all three.

Short answer: nothing in Harbourmaster today persists files per agent on Cloudflare. The Linux VM keeps files per session, by design. Every new chat, routine fire, trigger and MCP call is a new session, so it gets an empty VM. The isolate has no private folder at all, only the shared library. Managed Agents lose their container with each Anthropic session. Machines are the one runtime that already keeps a per-agent folder.

## A. How it works now, per runtime

### Cloudflare Pi, isolate environment (the default)

The `PiRun` Durable Object is named by the Harbourmaster session id (`apps/web/src/server/pi-run-port.ts:8-9`, comment at `pi-run.ts:114-118`). An agent gets the isolate unless its `runtimeConfig.environment` is `"linux-vm"` (`packages/services/src/cloud/environment.ts:24,40-45`).

- Working directory. Pi's `read`, `write` and `edit` work on the workspace library through `createLibraryEnv`, with `/library` as the only path and the cwd (`pi-run.ts:304-310`, `library-env/library-env.ts:1-9,529`). There is no Pi `bash` in the isolate (`library-env/library-tools.ts:1-3`).
- Backing store. R2 (`FILES` bucket) under `${workspaceId}/library/<path>`, indexed in D1 `library_entries` (`packages/services/src/library.ts:1-15,114-115`). Limits: 10 MB per file, 1 GB per workspace (`packages/db/src/shared.ts:53,56`).
- Sync. None. Every write goes straight to R2 and D1.
- Wipe. Never. Files persist until someone deletes them.
- Library. It *is* the working directory. The platform MCP server also exposes a `bash` tool over the library. Its description says files outside `/library` "exist only for this call and vanish afterwards" (`packages/mcp/src/tools/library.ts:43-46`, `apps/web/src/server/library-bash/run.ts:1-5`).
- Per-agent area. None. Every member may write anywhere in the library. `canWriteAt` returns true and carries the comment "Per-agent write roots are an open question" (`library.ts:104-108`).
- System prompt. "The read, write and edit tools work on the workspace library, which is the folder /library" (`library-tools.ts:15`). The attachment section says "write it inside your work directory (/library)" (`pi-run-files.ts:333-336`, `packages/protocol/src/attachments.ts:15-16`).

### Cloudflare Pi, Linux VM environment

- Working directory. `/workspace` in a Sandbox SDK container (`linux-vm/vm-port.ts:11-12`). Commands run with `cwd` `/workspace` and `HOME=/root` (`vm-core.ts:60,425-427`, `vm-env.ts:212`).
- Keying. The VM's Durable Object, `VmSession`, is named by the session id: `durableVm(this.env.LINUX_VM, sessionId)` (`pi-run.ts:276-278,285`) → `namespace.idFromName(sessionId)`, then (`linux-vm/durable-vm.ts:15-19`). The snapshot label is the session id too (`vm-session.ts:91`).
- Backing store. The container disk while it runs. When idle, a `DirectoryBackup` of `/workspace` goes to R2 at `FILES/vm-snapshots/` (`vm-session.ts:7-8,82-86`, `vm-core.ts:513-542`). The record of the latest snapshot sits in the `VmSession` DO storage under the `snapshot` key (`vm-core.ts:38,516-518`). On staging the bucket is `harbourmaster-staging-files`, which previews share (`apps/web/wrangler.jsonc:94-95,123-125`). Staging has an R2 lifecycle rule, `vm-snapshots-30d` (C.14 log, `docs/tasks/C.14-cloud-linux-vm.md`). The log mentions no rule for production.
- Restore. On the first call after the container stops, `start()` runs `prepareWorkdir`. It restores the stored snapshot, or makes an empty `/workspace`. A restore that fails is logged with `console.error`, the snapshot key is deleted, and the VM starts empty (`vm-core.ts:301-316,338-368`).
- Snapshot. Only from the alarm: every 30 s it checks, and after `LINUX_VM_IDLE_SECONDS` (180 on staging, `wrangler.jsonc:92`) with no call, `sleepNow` snapshots and destroys the container (`vm-core.ts:23-24,544-578`). There is no snapshot at the end of a run. If the container is already gone when the alarm fires, the alarm returns early (`vm-core.ts:566-568`). Three failed snapshots in a row destroy the VM anyway (`vm-core.ts:30-31,536-540`).
- Sync in per run. `placeSkills` deletes and rewrites `/workspace/skills` on every run start (`vm-workdir.ts:73-101`, called from `pi-run.ts:461-463`). `placeInputFiles` writes attachments to `/workspace/input`, which stays (`vm-workdir.ts:125-143`, `pi-run.ts:429-452`).
- Sync out. None. `[ATTACHMENT:path]` markers are uploaded from the library only (`pi-run-files.ts:207-257`, `pi-run.ts:602-606`), so a file written in the VM cannot reach the user. The C.14 review lists this under "Ideas beyond the scope" (`docs/reviews/tasks/C.14.md:57`).
- Library. Not mounted. The VM tools replace the library tools (`linux-vm/environment-tools.ts:15-25`), and the agent reaches the library through the platform MCP `bash` tool.
- System prompt. "The VM sleeps when it has been idle for a few minutes, and the files in /workspace are kept for the next message. Nothing else in the VM is. ... The workspace library is not in the VM" (`linux-vm/vm-tools.ts:17`). The same session also gets the attachment section, which says to write files "inside your work directory (/library)". `filesExtension` is installed for every session in the constructor (`pi-run.ts:204-206`), so a VM agent gets two prompt sections that contradict each other.

### Managed Agents

- Keying. One Anthropic session per Harbourmaster session. A run reuses the Anthropic session only if the row is open, under 7 days old, and its `agentFingerprint` matches the agent's current model, instructions and MCP servers (`packages/services/src/managed/service.ts:87-88,465-470`). The `managed_sessions` row is upserted on `session_id`, so a rotation overwrites the old row (`service.ts:569-577`, `packages/db/src/schema/managed.ts:99-118`).
- Working directory and backing store. The container of the Anthropic session, in one shared `cloud` environment with unrestricted networking (`managed/gateway.ts:334-365,415-433`). Nothing is uploaded at session start except the first message and the vault credentials (`service.ts:497-590`).
- Sync. None in or out. Input files are not passed: the agent is told "managed agents cannot read Harbourmaster files" (`service.ts`, `messageOf`, just after `createSession`).
- Wipe. The container goes with its Anthropic session: a new Harbourmaster session, a fingerprint change, or 7 days.
- Library. Through the platform `/mcp` server (the `bash` tool), reached with the session token in the vault (`service.ts:16-18,525-533`).
- System prompt. Instructions, then skills guidance, then secrets text (`service.ts:158-170`, `systemOf`). Nothing about files.
- What the API offers (SDK 0.118.0 in `packages/services/node_modules/@anthropic-ai/sdk`). Session `resources` can mount Files API files (read-only, default `/mnt/session/uploads/<file_id>`), GitHub repos, and memory stores (`resources/beta/sessions/sessions.d.ts:263-310,740`). A memory store mounts as a directory at `/mnt/memory/<slug>` and persists across sessions. It is text only, at most 100 kB per memory, paths up to 1,024 bytes, `read_write` or `read_only`, and takes up to 4,096 chars of per-attachment `instructions` rendered into the system prompt (`resources/beta/memory-stores/*.d.ts`, `sessions/resources.d.ts:121-150`). The memory store API uses beta header `agent-memory-2026-07-22`, and sessions use `managed-agents-2026-04-01`. Whether attaching a store needs both headers is untested.

### Machines (daemon, Claude Code)

- Working directory. `<home>/harbourmaster/<workspaceId>/<agentId>/work` (`apps/daemon/src/workdir.ts:26-35`). The home is `/home/hm-agent` in multi-user mode, the daemon user's home in single-user mode (`workdir.ts:63-72`, `agent-user.ts:8`). Claude Code runs with that `cwd` (`executor.ts:262-268`).
- Backing store. The machine's disk. It is per agent per machine.
- Wipe. Before each run the daemon deletes only `.claude/`, `.mcp.json` and `inbox/` (`workdir.ts:57-82`). Everything else persists across runs and sessions.
- Sync in. Skills into `.claude/skills/` (`skills-sync.ts:1-11`), input files into `inbox/` (`run-files.ts`, `workdir.ts:13-14`). Sync out: `[ATTACHMENT:]` markers inside the work dir are uploaded (`work-files.ts`).
- Library. Not mounted. Reached through the platform MCP server in `claim.mcpServers` (`executor.ts:320`, `packages/services/src/runs/machine-claim.ts:227`).
- Conversation resume works only on the same machine (`executor.ts:122-129`). If the agent moves to another machine, it starts with an empty work dir.
- System prompt. Claude Code preset, plus the agent's instructions, plus "To give the user a file, write it inside your work directory (<workDir>)" (`executor.ts:278-282`). Nothing says the folder persists.

### Sessions

A session is new unless the caller passes an `externalKey` that matches an existing one (`packages/services/src/runs.ts:452-476`). That means:

- UI: each new chat is a new session (`externalKey` defaults to the session id).
- Routines and HTTP triggers: every fire is a new session (`routines.ts:585`, `triggers.ts:544`, no key).
- MCP `start_run`: a new session each time (`apps/web/src/server/mcp/ports.ts:299`).
- Slack: one session per thread (`slack.ts:291`). Inbox: one per thread (`inbox.ts:442`).

## B. Why files vanish on staging

**Linux VM (most likely Dom's case).** The VM, its disk and its snapshot record all belong to one session (`pi-run.ts:277`, `durable-vm.ts:19`, `vm-core.ts:516-518`). A new chat or a routine fire is a new session, so it gets a new `VmSession` Durable Object with no `snapshot` key, and `prepareWorkdir` makes an empty `/workspace`. This is the C.14 design ("one VM per session", "files survive between messages", `docs/tasks/C.14-cloud-linux-vm.md`), not a bug in the snapshot code. The prompt even says the files "are kept for the next message", which an agent can read as forever.

Within one session there are two more ways to lose files, both unverified on staging:

1. The only snapshot is the idle one. Any stop that is not `sleepNow` keeps nothing: an out-of-memory kill, a host restart, or the platform's own inactivity stop. Cloudflare says a host stop sends SIGTERM and gives no runtime guarantee (developers.cloudflare.com/containers/faq). The image runs `sleep infinity` with no handler (`apps/web/container/Dockerfile`), and the alarm returns early once `container.running` is false (`vm-core.ts:566`). The next start then restores the last good snapshot, which may be old or missing. Deploys are less of a risk than I expected. `VmSession` starts its own image from `ctx.container.start()`, so it uses Durable Object scheduling, and the Sandbox docs say a deploy keeps a running instance with its files (developers.cloudflare.com/sandbox/concepts/lifetime). A deploy does restart the Durable Object, which resets the in-memory `lastActivity` and `busy` (`vm-core.ts:246-247`). That delays the snapshot rather than losing it.
2. The C.14 staging check never saw a sleep and restore happen. The log says the file "survived 4.5 min idle" and "Sleep/restore not directly observed" (`docs/tasks/C.14-cloud-linux-vm.md`, log of 17 Oct). With a 180 s idle time and 30 s checks, a 4.5 min test fits a container that never slept. A failed restore is logged and then silently starts empty (`vm-core.ts:307-313`). Nothing about snapshots reaches D1 or the run's events, so only Workers logs show it. Search them for `LinuxVm <sessionId>: restoring the snapshot failed` and `snapshot failed`.

**Isolate.** Files written with Pi's tools land in the library and persist. Nothing vanishes, but there is no private area. Files the agent makes outside `/library` with the MCP `bash` tool vanish after that one call, as documented. If Dom's agent is an isolate agent, the likely confusion is that its files are in the shared library, not that they are gone.

**Managed Agents.** The container dies with the Anthropic session. Each new Harbourmaster session makes a new Anthropic session. On staging, every edit to an agent's instructions, model or connectors changes the fingerprint and rotates the session even inside one chat (`service.ts:465-470`). Nothing is saved anywhere, by design.

**Machines.** Files persist per agent per machine. The traps: files written into `inbox/` or `.claude/` are deleted at the next run (`workdir.ts:66-68,74-81`), and moving the agent to another machine starts with an empty folder. This is almost certainly not Dom's staging case.

## C. Queries for the controller (staging D1, SELECT only)

Run with `bunx wrangler d1 execute harbourmaster-staging --env staging --remote --command "<sql>"` from `apps/web`. Timestamps are ISO strings such as `2026-10-18T09:00:00.000Z`.

1. The last 10 runs with agent, runtime, cloud environment, session and timing.

```sql
SELECT r.id AS run_id, r.session_id, s.origin, s.created_at AS session_created,
       a.name AS agent, a.runtime,
       json_extract(a.runtime_config, '$.environment') AS cloud_env,
       r.status, r.created_at, r.started_at, r.finished_at,
       substr(r.error, 1, 200) AS error
FROM runs r
JOIN sessions s ON s.id = r.session_id
JOIN agents a ON a.id = r.agent_id
ORDER BY r.created_at DESC
LIMIT 10;
```

2. Sessions per agent over the last 14 days. A count of sessions close to the count of runs shows that every message started a fresh VM or container.

```sql
SELECT a.name AS agent, a.runtime,
       json_extract(a.runtime_config, '$.environment') AS cloud_env,
       COUNT(DISTINCT r.session_id) AS sessions, COUNT(*) AS runs,
       MIN(r.created_at) AS first_run, MAX(r.created_at) AS last_run
FROM runs r
JOIN agents a ON a.id = r.agent_id
WHERE r.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days')
GROUP BY a.id
ORDER BY last_run DESC;
```

3. File and shell tool calls in those 10 runs, with the paths and commands they used. Payloads over 64 KB live in R2 (`payload_ref`) and show as NULL here.

```sql
SELECT e.created_at, e.run_id, r.session_id, a.name AS agent,
       json_extract(e.payload, '$.name') AS tool,
       json_extract(e.payload, '$.input.path') AS path,
       substr(json_extract(e.payload, '$.input.command'), 1, 200) AS command,
       substr(json_extract(e.payload, '$.input.script'), 1, 200) AS script
FROM events e
JOIN runs r ON r.id = e.run_id
JOIN agents a ON a.id = r.agent_id
WHERE e.type = 'tool.call'
  AND e.run_id IN (SELECT id FROM runs ORDER BY created_at DESC LIMIT 10)
  AND (json_extract(e.payload, '$.name') IN ('read', 'write', 'edit', 'bash', 'run_skill_script')
       OR json_extract(e.payload, '$.name') LIKE '%bash%'
       OR json_extract(e.payload, '$.name') LIKE '%library%')
ORDER BY e.created_at;
```

4. Tool results that point at missing files in the last 50 runs.

```sql
SELECT e.created_at, e.run_id, r.session_id,
       substr(json_extract(e.payload, '$.output'), 1, 300) AS output
FROM events e
JOIN runs r ON r.id = e.run_id
WHERE e.type = 'tool.result'
  AND e.run_id IN (SELECT id FROM runs ORDER BY created_at DESC LIMIT 50)
  AND (e.payload LIKE '%No such file%' OR e.payload LIKE '%ENOENT%'
       OR e.payload LIKE '%not found%' OR e.payload LIKE '%attachment missing%')
ORDER BY e.created_at DESC;
```

5. Library writes and deletes, to see where isolate agents put their files.

```sql
SELECT created_at, type, actor_kind, actor_id, run_id, session_id,
       json_extract(payload, '$.path') AS path,
       json_extract(payload, '$.size') AS size
FROM events
WHERE type IN ('library.write', 'library.delete', 'library.command')
ORDER BY created_at DESC
LIMIT 50;
```

6. Managed sessions and fingerprints. The row is overwritten on rotation, so `created_at` later than the session's first run means the Anthropic session was replaced mid-chat.

```sql
SELECT ms.session_id, a.name AS agent, s.created_at AS hm_session_created,
       ms.created_at AS anthropic_session_created, ms.closed_at,
       substr(ms.agent_fingerprint, 1, 12) AS fingerprint,
       ms.anthropic_session_id IS NOT NULL AS has_anthropic_session
FROM managed_sessions ms
JOIN sessions s ON s.id = ms.session_id
JOIN agents a ON a.id = s.agent_id
ORDER BY ms.created_at DESC
LIMIT 10;
```

7. Agent edits over the last 14 days. Each one rotates managed sessions, and switching environment moves a cloud agent between the isolate and a VM. This assumes `agent.updated` rows set `events.agent_id`, which I did not check. If the query returns nothing, drop the join and filter on `type` alone.

```sql
SELECT e.created_at, a.name AS agent, a.runtime, e.actor_id,
       substr(e.payload, 1, 300) AS payload
FROM events e
JOIN agents a ON a.id = e.agent_id
WHERE e.type IN ('agent.created', 'agent.updated')
  AND e.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days')
ORDER BY e.created_at DESC;
```

VM snapshot records are not in D1. They sit in each `VmSession` DO's storage, and the objects sit in R2 under `vm-snapshots/` in `harbourmaster-staging-files`. List that prefix in the R2 dashboard or with an S3-compatible client. Wrangler 4 has no object list command, only `get`, `put` and `delete`. Then compare object names (the session id is the label) with the sessions from query 2. A VM session with runs but no object never snapshotted. Workers logs for the staging Worker show restore and snapshot failures (strings in section B).

## D. Proposed design

### Goal and principle

Each agent gets three areas, named the same way in every prompt: **home** (yours, kept across sessions), **scratch** (temporary), and **library** (shared, kept). Each runtime maps them onto what it already has. The VM is the only runtime that needs a real code change for home. The others need a path convention and prompt text.

### Paths per runtime

| Runtime | Home (per agent, persists) | Scratch (temporary) | Library (shared) |
|---|---|---|---|
| Linux VM | `/workspace/home`, snapshotted to R2, cwd | everything else, chiefly `/tmp`. Gone when the VM sleeps | library tools via platform MCP (not mounted) |
| Isolate | `/library/agents/<slug>/` (convention) | none. MCP `bash` paths outside `/library` last one call | `/library` |
| Managed | `/library/agents/<slug>/` via platform MCP tools | the session container's disk | platform MCP tools |
| Machine | the existing work dir (cwd) | `<workdir>/tmp`, emptied before each run | platform MCP tools |

### Linux VM: key the VM by agent

The smallest change that gives a per-agent home is to name `VmSession` by agent id instead of session id. The existing snapshot and restore code then gives persistence across sessions for free, with no new table. One container per agent also means fewer containers to pay for.

1. `pi-run.ts` stores and passes `input.run.agentId` in place of the session id (`VM_KEY`, `#switchEnvironment`, `#executionEnv`). `durableVm(namespace, agentId)`.
2. Snapshot only `/workspace/home`. `prepareWorkdir` makes `/workspace` first (the restore needs the parent), then restores into `/workspace/home` or makes it empty. Skills and input files stay under `/workspace/skills` and `/workspace/input`, outside home, so they are scratch by construction. The default cwd becomes `/workspace/home`.
3. Snapshot after each run that used the VM, not only when idle. A host stop then loses at most the run in flight. The cost is one backup per run, a few seconds for a small home. Add a `checkpoint()` call to the port, called from `PiRun` when a run completes.
4. Record snapshot and restore outcomes where the controller can see them. Use one event type, `workspace.snapshot`, with `{ ok, bytes, ms, error? }`, written for the run that triggered it. A failed restore must also fail loudly, at least as a run event, rather than silently starting empty.
5. `placeSkills` currently deletes `/workspace/skills` and then writes it again. With two sessions of one agent running at once, a skill script in one run can lose its files mid-call. Write to `/workspace/skills.<runId>` and rename it over the old folder.
6. The egress intercept stores one `VmEgressRun` with a run id (`vm-port.ts:69-82`, `vm-core.ts:506-511`), and `SecretsOutbound` records deliveries against it. With two sessions on one VM, the last run to call `setEgress` wins, so the other session's proxied requests are logged under the wrong run. It is the same agent with the same secrets, so nothing leaks, but the audit trail is off. Accept that for now, or key the intercept by agent.

What changes for the agent. Concurrent sessions of one agent share one disk, which is what "per agent" means. Last write wins, as on any shared Linux box. Scratch is gone when the VM sleeps (3 idle minutes), not exactly at session end. While another session of the same agent keeps the VM awake, scratch survives into it. I think that is close enough to "gone after the session". The prompt says "may vanish at any time after this message" so nobody depends on it.

Size. Cap home at 1 GB as a soft limit. Measure with `du -sb` before each snapshot and add a warning to the event when it is over. Refuse nothing for now. The `standard-1` disk and snapshot time set the real ceiling.

The alternative is to keep one VM per session and add a second snapshot of `/workspace/home`, recorded per agent in D1 and restored at VM start. That keeps sessions isolated, but needs a table, an ordering rule for concurrent snapshots (last writer wins, losing the other session's changes), and a restore on every cold start. It is more code for a weaker result. See decision 1.

### VM attachments

`outputsOf` for a VM session reads marker paths from the VM (`/workspace/home/...` or `/tmp/...`) with `vm.readFile`, not from the library. `filesExtension` renders the work directory per environment, so the VM prompt no longer says `/library`. This fixes the contradiction in section A and C.14's open idea.

### Isolate and managed: a library folder

Home is `/library/agents/<slug>/`. `PiRun` (isolate) and the managed service create it with `library.mkdir` before the first run if it is missing. The prompt names it. In the isolate, `createLibraryEnv` takes a `cwd` (`library-env.ts:529`), so pass the home folder and relative writes land there without the agent having to remember the path. The folder uses the slug because people read it in the library page. Renaming an agent then leaves its old folder behind, see decision 8. Everyone in the workspace can still read and write it. `canWriteAt` (`library.ts:104-108`) is where enforcement would go later, see decision 4. Library limits apply: 10 MB per file, 1 GB per workspace in total.

For Managed Agents this home is not a local folder. The agent reaches it through the MCP tools. Anthropic memory stores would give a real folder at `/mnt/memory/<slug>`, but only for text, at most 100 kB per file, and it adds per-agent state on Anthropic's side that the UI cannot show. I'd keep the library folder for now, see decision 3. Scratch is the container disk, gone when the Anthropic session ends or rotates.

### Machines: add scratch, say what persists

Add `tmp/` to the folders `prepareWorkDir` empties before each run (`workdir.ts:66-68,74-81`). The work dir stays home. Two runs of one agent on one machine share the folder, and today `inbox/` already has the same race. Leave it.

### System prompt text

One builder in `packages/protocol` (the daemon and the web app already share `attachments.ts` there): `workspaceInstructions({ home, scratch, library, homeIsLocal })`. Each runtime passes its paths. It replaces the files sentences in `vm-tools.ts:17`, `library-tools.ts:15`, `attachmentInstructions` (`attachments.ts:15-16`) and the daemon's `systemPrompt.append`, and gets added to managed `systemOf`. Draft for the Linux VM:

```text
Your files live in three places.
- Home: /workspace/home. It is yours and keeps its files across all your sessions. Relative paths start here. Keep notes, code and data you want to find again here, under 1 GB in total. Other sessions of yours may use it at the same time.
- Scratch: /tmp, and anything else outside /workspace/home. Use it for downloads, builds and temporary files. It is deleted when the VM sleeps after a few idle minutes, so never keep anything there that you need after this message.
- Library: the workspace library, shared with every agent and person in this workspace and kept for good. It is not in the VM. Reach it with the library tools. Put finished work that people or other agents should see there.
To give the user a file, put [ATTACHMENT:<absolute path>] on its own line in your final answer.
```

Isolate: home `/library/agents/<slug>/`, "you have no scratch folder: files the bash tool writes outside /library last for that one call", library `/library`. Managed: home is the same library folder "reached with the library tools, not a local folder", scratch "this session's own disk, gone when the session ends". Machine: home "your working folder, kept on this machine", scratch `./tmp` "emptied before every run".

### UI and MCP visibility

Isolate and managed homes are library folders, so the library page already shows them. The VM home is a tar in R2 that no page shows. For now the prompt tells agents to copy work people should see into the library. A read-only view of the VM home on the agent page waits for decision 6. No new MCP tool is needed.

### Migration

None. Existing VM snapshots are keyed by session, and their records live in each session's `VmSession` storage. The new per-agent object cannot find them. On staging they are one day old (C.14 went live on 17 Oct) and the 30-day lifecycle rule removes them. Production needs the same lifecycle rule on `vm-snapshots/` in `harbourmaster-files` before VM agents run there (Dom, dashboard). Old session `VmSession` objects with a running container stop at their inactivity timeout.

### Tasks

```yaml
id: W.1
title: Workspace instructions builder shared by all runtimes
milestone: W
size: S
status: todo
depends_on: []
branch: null
```

Scope: `workspaceInstructions({ home, scratch, library, homeIsLocal })` in `packages/protocol`, rendering the three areas and the attachment line as in the draft. Keep `attachmentInstructions` until the callers move. Check: `bun test packages/protocol` with one case per runtime's inputs, and the text contains no `/library` when the library is not local.

```yaml
id: W.2
title: Linux VM keyed by agent with a persistent /workspace/home
milestone: W
size: M
status: todo
depends_on: [W.1]
branch: null
```

Scope: name `VmSession` by agent id (`pi-run.ts` `VM_KEY`, `#switchEnvironment`, `#executionEnv`, `durable-vm.ts`). Snapshot and restore `/workspace/home` only, making `/workspace` first. Default cwd `/workspace/home`. `placeSkills` writes into a run-specific folder and renames it over the old one. VM prompt section from W.1. The egress intercept stays keyed by the last run, a known audit gap (decision 1). Check: `vm-core.test.ts` and `vm-workdir.test.ts` cover restore into home, the backup dir, and skills placed while a second run reads them. A `pi-run` test shows two sessions of one agent reach the same VM name. Staging, by the controller: a VM agent writes `/workspace/home/note.txt` in chat A, the VM sleeps (wait over 4 minutes and see the snapshot object in R2), and a new chat B reads the file. `/tmp/x` from chat A is gone in chat B.

```yaml
id: W.3
title: VM snapshot after each run, with a workspace.snapshot event
milestone: W
size: S
status: todo
depends_on: [W.2]
branch: null
```

Scope: `checkpoint()` on the VM port, called by `PiRun` when a run that used the VM completes. `workspace.snapshot` in `EVENT_TYPES` with `{ ok, bytes, ms, error? }` for checkpoints, idle snapshots and restores. A failed restore writes `ok: false`. A `du -sb` over 1 GB adds `warning`. Check: `vm-core.test.ts` covers a checkpoint, a failed checkpoint that keeps the VM up, and the over-size warning. Staging: query 3 shows a `workspace.snapshot` event per run.

```yaml
id: W.4
title: Attachments from the Linux VM
milestone: W
size: S
status: todo
depends_on: [W.2]
branch: null
```

Scope: in a VM session `outputsOf` reads `[ATTACHMENT:]` paths from the VM with `readFile`, refusing paths outside `/workspace` and `/tmp`, with the same size cap and notes as `uploadOutputs`. `filesExtension` renders per environment. Check: `pi-run-files.test.ts` with the fake VM for a home file, a scratch file, a refused path and a missing file. Staging: a VM agent returns a file from `/workspace/home` as a chip.

```yaml
id: W.5
title: Isolate and managed homes in the library, prompts for both
milestone: W
size: S
status: todo
depends_on: [W.1]
branch: null
```

Scope: `PiRun` (isolate) and the managed service create `agents/<slug>/` in the library when missing before a run. The isolate's `createLibraryEnv` gets that folder as its `cwd`. Library prompt sections from W.1 replace `library-tools.ts:15` and the attachment section. The managed `systemOf` gains the W.1 text. Check: `library-tools.test.ts` and `managed.test.ts` assert the prompt names the agent's folder, and a run on an agent with no folder creates it once.

```yaml
id: W.6
title: Machine scratch folder and prompt
milestone: W
size: S
status: todo
depends_on: [W.1]
branch: null
```

Scope: `prepareWorkDir` also empties `tmp/` in both modes. The daemon's `systemPrompt.append` uses W.1 with home = work dir and scratch = `<workdir>/tmp`. Check: `workdir.test.ts` (both modes empty `tmp/` and keep other files) and `executor.test.ts` (the append names home, scratch and library).

W.2 is the one that fixes Dom's report. W.3 to W.6 can run in parallel after their dependencies.

## Open decisions for Dom

1. **VM per agent or per session.** Per agent shares one disk between concurrent sessions of the same agent. Per session plus a per-agent home snapshot keeps sessions apart but costs a table and loses one session's changes when two snapshot at once. Per agent also logs proxied requests under whichever run last set the egress. Default: per agent.
2. **Scratch lifetime.** "Gone when the VM sleeps or before the next run" instead of strictly per session. A per-session scratch folder would need cleanup at a session end that Harbourmaster never sees. Default: the looser rule, stated in the prompt.
3. **Managed home.** A library folder through MCP tools, or an Anthropic memory store mounted at `/mnt/memory/<slug>` (text only, 100 kB per file, state on Anthropic's side). Default: library folder now, memory store only if managed agents need a local folder.
4. **Privacy of library homes.** Convention only, where everyone can read and write `agents/<slug>/`, or enforce it in `canWriteAt` so only that agent and people can write there. Default: convention only.
5. **VM home size.** A soft 1 GB cap with a warning in the snapshot event, or a hard refusal. Default: soft cap.
6. **VM home in the UI.** None for now, with agents copying shareable work into the library, or a read-only browser on the agent page. Default: none for now.
7. **Old session snapshots.** No migration, let the lifecycle rule expire them, and add the same rule for production before VM agents run there. Default: yes, and Dom adds the production rule.
8. **Library home folder name.** `agents/<slug>/`, which reads well but is orphaned when the agent is renamed, or `agents/<agentId>/`, which never moves but is unreadable. Default: slug.

**Decisions, 18 Oct 2026.** Dom accepted all defaults above. Tasks W.1 to W.8 are in `docs/tasks/`. W.7 and W.8 add the library-folder sync from section E.

## E. Library as a folder in the VM and on machines: concurrent edits (Fable review, 18 Oct 2026)

- Don't mount R2. `list` and `stat` read D1 only, so FUSE writes would not show in the UI, emit no `library.write` events, and get no compare-and-swap. Fetch on demand is a mount by another name.
- The version already exists: `library_entries.etag`, and `write(ifEtag)` is a compare-and-swap through R2 `onlyIf.etagMatches` (`library.ts:385-391`, `r2-library.ts:29-31`). The isolate already uses it.
- Sync in one subtree only: `agents/<slug>/` plus paths named in the agent config, skipping files over 10 MB. Keep a manifest `{path, etag, sha256}` beside the working copy. The rest stays reachable through the MCP tools.
- Sync out at run end and at periodic checkpoints: each changed file goes through `write(path, bytes, { ifEtag })`. On `conflict`, write the local bytes as `<path>.conflict-<runId>` and keep the remote file. No merge, no last-write-wins.
- Local delete: `stat` and remove only if the etag still matches. New local file: `stat` first, and an existing remote file becomes a conflict copy. Renames count as delete plus create.
- Two sessions of one agent: sync in never overwrites a local file whose hash differs from the manifest. One manifest per working copy, not per run.
- The agent learns about conflicts through a new `library.conflict` event and a line in the next run's prompt that lists pending `.conflict-*` files under its subtree.
- Machines: write back with the run token from the claim (`machine-claim.ts:227`), since the daemon's principal cannot write.
