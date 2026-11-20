# ME milestone gate, round 1

Commit 45a5a0ad on main, range `me-start..45a5a0ad`, judged against the ME section of `docs/v4/build-plan.md`, `docs/research/ui-reimagine-2026-11/memory-and-dreaming.md`, the task files ME.1 to ME.13, `CLAUDE.md` and "Rules that are easy to break" in `docs/HANDOVER.md`. Only the ME work was judged. Other merges in the range were read where they touch memory (DR's dream principal, TM's team rooms).

## Verdict

Not clean. Four must-fix findings, which make three tasks (finding 2 is fixed by the same change as finding 1). All are about where a person's private notes go or how far the outside-text guard reaches.

Most of ME is sound. The memory service is the only writer of memory files (a test enforces it), and every write lands as one library version with its `memory_changes` row in the same `atomic` call. Learn levels, the secret patterns, the never list and rules authorisation behave as the tasks ask. `memory.changes`, the Needs you sources, the roster count and the dream's change list all filter by `user_scope`. A held private note goes to its own person only. The library hides another person's private file from users, admins included, and from runs.

The gap is the rule that decides when a run may see its person's private file. Today it is "the run is on behalf of that person". That lets private notes into runs whose replies other people read, and into working copies that other people's runs share.

## Findings

| # | Severity | Finding | Area | Resolution |
|---|---|---|---|---|
| 1 | must-fix | Private notes reach runs whose output other people read. `launch-context.ts` keeps private notes out of the prompt only for sessions with several speakers, and `sessionSupportsSpeakers` counts only the `artifact`, `slack` and `a2a` origins. A team room post starts the run as the poster, with origin `inbox`, so the poster's private notes go into the prompt and the reply goes to the whole room, the lead included. The same holds for a Q&A board run. The library is looser still. `resolveMember` scopes a run by `onBehalfOfUserId` alone, so in a Slack channel thread, an artifact chat or a team room the run can read the person's private file with the library tools, and the daemon routes, the VM sync and the live-sync audience hand it over too. The ME.10 review listed the library half as "beyond scope". | Prompt, library, sync | Task MF-1 |
| 2 | must-fix | Private notes never load in a Slack DM. A DM is a private session with origin `slack`, so the same speaker check drops its private notes from the prompt. Slack DMs were the only source of private notes before ME.13, so a note kept in a DM never comes back in the next DM. `launch-context.test.ts` pins this behaviour. Not a leak, and the same rule fixes it. | Prompt | Fixed by MF-1 |
| 3 | must-fix | Shared working copies keep one person's private file where another person's run can read it. The Linux VM is keyed by agent (`durable-vm.ts`), and `vm-library-sync.ts` says the agent's sessions share the VM, its working copy and its manifest. A cloud run for person A syncs `memory/private/A.md` into that copy, and a run for person B in another session of the same agent, running at the same time, can read it with bash. A later sync for B removes the file only if it is unchanged, and `syncLibraryIn` never throws, so a lock timeout leaves it in place. The machine daemon has the same shape. Its working copy is per agent (`executor.rs`), a failed sync-in logs and the run continues, and a local edit to the private file makes the next sync keep it. The new VM tests build a fresh VM for each person, so they cannot see this. | Cloud VM sync, daemon sync | Task MF-2 |
| 4 | must-fix | The outside-text guard sees only some web use. `usedWeb` in `memory/provenance.ts` holds a note when the run has a `browser.action` event or a `network.request` with `via: web_fetch`. Cloud `curl` and `run_script` fetches log `network.request` with other `via` values, Claude Code's WebFetch and WebSearch on a machine run produce tool events, and Managed Agents' `web_fetch` does as well. None of them is caught, so on those paths a note learned from a web page applies at once under "Tell me after". ME.3 asks for this guard "enforced in code", and the design names the forward-invoices attack it closes. | Guard rules | Task MF-3 |
| 5 | nit | Any member can edit or forget an agent's shared notes, and the change applies at once with no hold. The design's scope table names the agent, its dream and its owner as the writers. ME.6 only requires that members cannot change rules. Decide whether a non-owner's edit or forget should be held for the owner. | Memory service, Knows tab | Decide |
| 6 | nit | A plain library write under `agents/<slug>/memory/` by a person skips the memory service: no secret check, no never list, no change row. Any member can do it to the shared files. The format doc allows hand fixes, and the ME.10 review already noted it. | Library | Carry forward |
| 7 | nit | The default workspace never entries ("Passwords and keys", "Card and bank numbers", "Health details") match only that exact run of words, because "and" never splits an entry. The secret patterns still catch keys and card numbers. Health details are caught only if the note says those two words. | Guards | Carry forward from ME.10 |
| 8 | nit | `approve` and `undo` write without the never check. A held note approved after the list changed, or an undone forget of a note now on the list, still goes in. Both are person actions. | Memory service | Carry forward from ME.10 |
| 9 | nit | A person may name any session of the agent as a note's source, including another member's `ui` session they cannot read. `sessionOf` checks workspace and agent, not visibility. Nothing is read from it, but the Knows tab then shows that source link to everyone. | Provenance | Check `visibleSessions` for a person's source |
| 10 | nit | Private file paths, which carry the person's Clerk user id, show where contents do not: `library.write` events in the event log, the "outside" list of a run's task files, and an empty `private` folder in another member's Library page. They reveal that a person has private notes and when they changed. | Library | Consider leaving private paths out of events and task files |
| 11 | nit | A run on behalf of A in a shared session can find A's `ui` and private conversations through `search_history`. The same was already true of `search_sessions` and `read_session` before ME. Whatever rule MF-1 sets for private notes should apply to history search too. | Agent tools | Follow MF-1's rule |
| 12 | nit | On Managed Agents the notes ride only in a new session's first message, so a note kept mid-session does not reach the later runs of that session. | Prompt, managed | Note in the format doc or refresh per run |
| 13 | nit | Not verified at this gate: migration 0055 on a copy of staging data (ME.1), the Managed Agents memory walk, a machine agent calling `remember` itself, and the two-member private-note check on staging (ME.9 steps for Dom). | Verification | Dom's steps |

## Task-ready scope and check

### MF-1 One rule for who may see a person's private notes

Scope. Replace "the run is on behalf of that person" with one allow-list rule, used both by the prompt (`launch-context.ts`, `memory/prompt.ts`) and by the library (`resolveMember` in `library.ts`, so the library tools, the daemon routes, the VM sync and the audience in `library/audience.ts` follow). A run sees `memory/private/<userId>.md` only when its session is private or has origin `ui`, and the session's actor is that user. Every other session gets no private file: team rooms (`inbox`), Q&A, Slack channels, mail, artifact chats, A2A, routines and triggers. Hand-offs and subagents keep the rule through their own session's privacy, which `runs.ts` already derives. Drop the origin list from the prompt path so a Slack DM, which is private, gets its notes back. Apply the same rule to `search_history`, or record why not.

Check. Service tests: a team room run started by A's post has none of A's private notes in its launch context and cannot read, list or stat A's private file through the library. The same for a Slack channel thread, an artifact session and a Q&A run. A Slack DM run for A, and a private `ui` run for A, both carry A's private notes. The audience sends a private path only to a run whose session passes the rule. Update the existing launch-context test that pins `slack` to no private notes. `bun run check && bun run test && bun run build` pass.

### MF-2 No private file left in a shared working copy

Scope. On the Linux VM and on the machine daemon, a working copy that outlives one run must never hold a private memory file when a run for another person, or for no person, can read it. Options for the implementer: keep private files out of the shared copy and give the run its own private notes another way (the prompt already carries them), or give each run its own per-person folder that is removed at run end. At minimum, a sync-in removes any private file not in the run's remote list whatever its local state, a failed or timed-out sync-in does not start the run with the previous person's file in place, and the memory folder syncs as read-only, since a run can never write there.

Check. A VM test with one VM and one working copy: sync in for a run for A, then for a run for B, and B's copy has no `private/A.md`, both while A's run is still live and after it ends. The same with A's file edited locally and with the lock held so B's sync times out. A daemon test: after a run for A, a run for B and a routine run see no `private/A.md` in the working copy, including when the local copy was edited and when sync-in fails. `bun run check && bun run test && bun run build` pass, and `cargo test` in `apps/agentum`.

### MF-3 The outside-text guard covers every web path

Scope. `usedWeb` in `memory/provenance.ts` counts any `network.request` the run made, whatever its `via`, plus `browser.action`, plus the tool events for web tools on the machine and managed runtimes (Claude Code's WebFetch and WebSearch, Managed Agents' `web_fetch` and `web_search`). Find the event types and names those runtimes record, and add them. If a path cannot be detected at all, such as a raw `curl` in a machine agent's shell, write that limit down in `docs/v4/memory-format.md` and hold every agent note from that runtime when the run had shell access, or record the decision not to.

Check. Service tests: a `remember` from a run whose only web use is a cloud `curl`, a cloud `run_script` fetch, a machine WebFetch tool call and a managed `web_fetch` call is held under "Tell me after" and "Quietly". A run with no web use still applies at once. `bun run check && bun run test && bun run build` pass.

## What was run

- The ME service tests in `packages/services` (memory, library, launch context, library memory): 274 pass, 0 fail.
- `bun run check` from the root: passes (17 tasks, boundary lint clean).
- The ME web tests in `apps/web` (memory ports, run library routes, VM sync, Knows tab, remember form, desk cards): 245 pass, 0 fail.
- The full root `bun run test` and `bun run build` were not run at this gate. The task logs record them passing on main after each merge, apart from the known FX.1 flakes.

## Verdict

Not clean: 4 must-fix findings in 3 tasks (MF-1, which also fixes finding 2, MF-2 and MF-3).
