# ME end-to-end walkthrough

Task ME.9. Verdict: memory works end to end on local for the fake, cloud and machine runtimes. A note is written (by a person, from a message, or by an agent through `remember`), reaches the next run's input, is used by the model, and arrives on a machine by library sync. Two gaps in the ME code were found by the walk and fixed on the branch. The browser proof is `docs/reviews/tasks/ME.9/browser.md`, run by two fresh verifiers at 1280x800 and 390x844. Its literal verdict is FAIL, for reasons that are not memory defects (see "Console and network"). Every flow and size passed functionally. Managed Agents was not run and is a step for Dom.

## What was real and what was not

Who did what is marked on each line: "verifier" means a fresh browser verifier (round 1 or 2 in browser.md), "dispatcher" means the task's dispatcher, in a shell or in its own browser dry run.

| Runtime | What ran | Who |
|---|---|---|
| Fake | Agent `mem-fake`. A note remembered from a message shows on Knows with its source link, and a new conversation's run input carries it. | verifier, both sizes |
| Cloud, scripted model | Agent `mem-cloud` on the dev-only `faux` model. A prompt `call harbourmaster_remember {...}` makes the cloud run call the real `remember` tool through `/mcp`. | verifier, both sizes, and dispatcher |
| Cloud, real model | Agent `mem-claude` on `claude-haiku-5-5`. A real Anthropic key was in the local workspace. It called `remember`, and a new conversation used the note ("Kestrel"). | verifier, both sizes |
| Machine | The real Rust daemon (a debug build copied from the main checkout's `apps/agentum/target`, newer than the last change to `apps/agentum/src`), enrolled as machine `me9` with its own config and state folders, and the real Claude CLI (2.1.327). The note arrived in the daemon's working copy and the agent answered with it. | verifier, both sizes. The binary's origin and the CLI version are the dispatcher's setup notes, not in browser.md. |
| Managed Agents | Not run. | Dom, see below |

The Anthropic key for the local workspace came from `apps/web/.env.local`. The dispatcher put it into the key field on the Home page of the local app from a shell variable. It was not written into any file or doc, and it is stored only in the local D1 database (`workspace_anthropic_keys`).

Not exercised: a machine agent calling `remember` itself (the machine runs only read memory and repeated it; the cloud runs exercised the tool and its `/mcp` path, which the machine's tool calls share), whether an admin can read another person's private file, and Managed Agents.

## Result by scope item

| Scope item | Result |
|---|---|
| Fake runtime: remember something, new conversation, note in the run input, agent uses it | Passed after a fix. The fake runtime never loaded memory, so there was nothing to see (fixed, below). On the fake, "uses it" means "repeats it": the reply lists the notes under "I remember:". Real use is shown by the cloud and machine runs, where the model answered from the note. |
| ask_first, agent calls `remember`, approve from Needs you | Passed after a fix. The note was held, the header count rose without a reload, the drawer entry opened the item page, and Approve applied it (decided by the person, status applied, on Knows and in Learned this week). Reject kept it off the notes list. The item page had no buttons before the fix (below). |
| Private note invisible to a second member in the Library page | Passed. The plain member's Library listed an empty `private` folder, opening the file by its direct URL answered "Not found", Knows showed none of it, and a run the member started did not list it. The admin's own run did. |
| Machine agent: memory folder arrives by library sync | Passed. `work/library/agents/<slug>/memory/` in the daemon's working copy held `index.md` and the note files at the start of each run, and no `private/` file. |
| Cloud agent on local | Passed for the scripted and the real model. Notes reach the instructions (ME.5), the tool call is held or applied by the learn level. |
| Managed Agents | A step for Dom. |
| ME.6 log item: remember a message and find it on Knows with its source link | Passed on both sizes. The source line reads "Saved from a conversation, <date>", and the link goes to that conversation. |

## Fixed on this branch

- The fake runtime ignored memory. `createFakeRuntime` now takes the library and, when the run's prompt carries notes, appends them to the echo ("Echo: hello", then "I remember:" and one bullet per note). An empty memory leaves the reply byte for byte as before. A tool-mode run answers with the tool's result and lists no notes, and a failed memory load is logged and the run still echoes. Tests in `fake-runtime.test.ts`, including a private note that reaches only its person's run.
- A held memory note in the Needs you card had no Approve or Reject, because `memory_note` fell through to the default summary. Approval was possible only on the Knows tab. The card now shows the note and offers Approve and Reject, which call `memory.decide` (new `memory-note-actions.tsx`, test in `needs-you-card.test.tsx`). Round 1 showed the first version printed the card's heading instead of the note text. Round 2 confirmed the note text shows at both sizes.

## Console and network

Round 2's literal verdict is FAIL for one thing: the browser console shows a Clerk `POST /v1/client/sign_ins` 400 when `/api/dev-login` is opened in a browser that is already signed in (reproduced twice, and seen on a first sign-in too; a clean scratch Playwright context did not show it). It is the sign-in tool, not a memory page, and no memory page at either size returned a 4xx.

Round 1 also counted the deliberate 404 on the plain member's direct private-file URL (the proof of the denial, kept in round 2 as one labelled probe per size), and it saw "tRPC desk.rail failed" lines in the dev server log. Two, at 18:36 and 18:37 before the verifier started, carried `SQLITE_BUSY`, when the dispatcher's own seed scripts were writing to the same D1 file. Six more at 18:51:11 gave no cause and coincided with a finishing run and the verifier's `sqlite3` reads, so the verifier could not tell whether its reads caused them. Round 1 also left unexplained why the member session's console held 98 accumulated 404 lines when its per-page tests accounted for far fewer. Round 2 kept its reads to quiet moments and saw no `desk.rail` failures and no `[error]` forwards. So the lock lines look like contention on the local D1 file, but that is an inference, not something shown.

## Proposed tasks

### ME.11 Fix the cloud follow-up message for the scripted model

Finding. A second message in the same cloud conversation comes back as an empty echo ("echo:") on the `faux` model. `bun scripts/e2e/cloud.ts --server http://localhost:<port>` fails at its second run ("expected \"echo: second message\", got \"echo: \""). The dispatcher ran this script, and a verifier saw the same empty echo in the browser (round 1). It happens on a branch that only changes the fake runtime and a Needs you component, so it should be on `main` too, but it was not run on `main` itself. A real model follows up correctly (a follow-up in a `mem-claude` conversation answered "Pineapple"), and the fake runtime echoes follow-ups correctly. So it is probably in the scripted model's path or the Durable Object's handling of a second run in a session, but the cause was not found and it was not bisected.

Scope. Find the cause and fix it, or fix the faux model if it is only there. Check the run input the second run carries into `pi.submit`.

Check. `scripts/e2e/cloud.ts` passes against a local dev server on a free port. A test at the layer where the cause is.

### ME.12 The Needs you row for a held note

Finding. In the Needs you drawer a held note shows the agent's sentence twice ("mem-cloud wants to remember something" as the title and again beside the agent tile), and never the note itself. The text only shows on the item page.

Scope. For `memory_note` rail cards, make the second line the note text (clipped) instead of repeating the heading, in the rail card's status or detail. Keep the heading.

Check. A rail test for the card fields, and a browser look at the drawer at both sizes.

### ME.13 A way to start a private conversation (needs a decision)

Finding. A note is private only when its session has `private = 1`, and only Slack DMs set that. In the app a person cannot start a private conversation, so a private note cannot come from the browser. The walkthrough set the flag with one `UPDATE` on the local database.

Decision first. Either leave private notes to Slack DMs and say so on the Knows tab, or add a "private" switch when starting a conversation and show a private marker on the person's own Knows list (today Dev User's private notes appear next to the shared ones with no marker).

Scope. Whichever option is chosen: the Slack-only note in the Knows tab copy, or the start-conversation switch plus the marker.

Check. If built: browser, start a private conversation, remember a message, see the marker on Knows, and the second member sees nothing in the Library or on Knows.

## Not memory, seen on the way

- The `agent-login` script's default redirect points at port 3000. Pass `--base-url http://localhost:<port>` for a dev server on another port.
- At 390 px the floating dev badge sits over the Send button on a conversation page (Ctrl+Enter works), and the "Open Knows" toast covers the composer buttons. The toast also lasts only a few seconds, so a script has to click it in the same command.
- The drawer showed "Working, 1 running" right after a cloud run ended while every run in the database was done.
- The Library breadcrumb leaves out the last folder (`/library?dir=agents/mem-fake/memory` shows "Library / agents / mem-fake").
- The plain member sees Rename, Move and Delete on files in an agent's `memory/` folder in the Library, and Edit and Forget on notes in Knows. The memory format doc allows a person to fix a file by hand, and the ME.10 review already notes that a hand edit skips the never list.
- Agents made by the dev scripts (`seed-fake-agent.ts`) are created by a script user with no owner, so held notes for them go to nobody the browser user can see. The walkthrough created its agents as the real dev user instead (below).

## Steps for Dom

- Managed Agents: run the same memory check on staging with the staging Anthropic key. Start a managed agent's conversation, remember a message, start a new conversation and check the model answers from the note (the notes ride in a new session's first message, see ME.5).
- After deploy, repeat the private note check once on staging with two real members, in a Slack DM and in the Library page.
- Decide ME.13.

## How the local setup was made

So the walk can be repeated. From the worktree, on a free port that matches `PUBLIC_BASE_URL` in `apps/web/.env.local` (the cloud object and the fake tool mode call back to it):

1. `cd apps/web && bunx wrangler d1 migrations apply DB --local && bunx vite dev --port <port> --strictPort`, then open `/api/dev-login` once.
2. Put the Anthropic key in the Home page key field (or Settings, model keys), from a shell variable.
3. Create the agents as the real dev user, so they have an owner who sees Needs you items: a fake agent, a cloud agent on model `faux`, a cloud agent on a real model (`claude-haiku-5-5`) and a machine agent. A scratch script over `createAgentsService` did it for this run; it is not committed.
4. For the machine: `bun scripts/dev/enroll-token.ts --name <name>`, then `agentum enroll --url http://localhost:<port> --code-stdin --name <instance> --claude <path to claude>` with `AGENTUM_CONFIG_DIR` and `AGENTUM_STATE_DIR` set to folders with mode 700 (the daemon refuses looser modes), then `agentum run --instance <instance>`. Give the agent `machineId` of that machine.
5. Set the cloud agent's learn level to Ask me first on its Knows tab. Start a new conversation with `call harbourmaster_remember {"kind":"work","text":"..."}`.
6. The plain member signs in with `bun run agent-login --email dev+member@harbouredgeintelligence.ai --base-url http://localhost:<port> --redirect /home`.
