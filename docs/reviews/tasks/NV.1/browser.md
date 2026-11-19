# NV.1 browser verification

Verdict: pass

Every flow worked at 1280x800 and 390x844. No console errors and no failed requests on any page (checked per page, and again across a full sweep of all Find entries at both sizes). One leftover wording defect was found on /triggers (see Wrong wording); it does not break a flow.

Setup: worktree head 2bd6b1ee, `vite dev` on port 3117 against the local D1, agent-browser session `nv1-verify`, signed in through the dev login. The workspace was empty, so I created data. The "Runs on a test runner" runtime (`fake`) cannot be picked in the UI without a provider key, so I inserted one agent ("Verifier Bot", runtime `fake`) into the local D1 with `wrangler d1 execute --local`, then created every conversation and task through the UI (New menu, reply box). Remote was not touched.

Browser note: agent-browser's default Chromium was missing, so I pointed it at the installed Playwright headless shell (chromium_headless_shell-1248). `wait --load networkidle` never settles in dev (HMR socket), so I used fixed waits.

## 1. Find: label vs page heading

Opened with Ctrl+K and picked every entry with the keyboard. Identical at both sizes.

| Entry label | Opens | h1 |
|---|---|---|
| Assistant (accepted exception) | /desk?assistant=new, opens the Assistant panel | desktop "Add your AI account" (the Desk item shown), phone "Needs you" |
| Desk | /desk?view=board | Desk |
| Conversations | /sessions | Conversations |
| Log | /log | Log |
| Q&A | /qa | Q&A |
| Inbox | /inbox | Inbox |
| Map | /map | Map |
| Routines | /routines | Routines |
| Triggers | /triggers | Triggers |
| Skills | /skills | Skills |
| Library | /library | Library |
| Artifacts | /artifacts | Artifacts |
| Apps (accepted exception) | /artifacts?kind=app | Artifacts |
| Enrol a machine (accepted exception) | /settings/machines | Machines |
| Agents | /agents | Agents |
| New agent | /agents/new | New agent |
| Model providers | /settings/model-providers | Model providers |
| Connectors | /settings/connectors | Connectors |
| Secrets | /settings/secrets | Secrets |
| Artifacts (Settings group) | /settings/artifacts | Artifacts |
| API keys | /settings/api-keys | API keys |
| Connected apps | /settings/connected-apps | Connected apps |
| Agent connections | /settings/agent-connections | Agent connections |

The old hints (Threads, Questions, Schedules and so on) show only as the grey side hint, not as labels. Dynamic agent entries (the list gains "Verifier Bot" once an agent exists) open that agent's main conversation, not the profile. That page has an empty h1 until the first message, so label and heading differ for that entry. This was already how the dialog worked; flagged only because the spec says every entry.

Screenshots: desktop-1.png, phone-1.png (Find open).

## 2. New menu

The menu reads "New conversation" and "New agent" at both sizes. "New conversation" opens a dialog titled "New conversation" with fields "Agent" and "What should it do?" and the button "Start conversation". Starting one lands on /threads/<id> with the title from the first message, status Done, and the echo reply. The Desk board has a "+ New conversation" button too.

Screenshots: desktop-2.png and phone-2.png (menu), desktop-3.png and phone-3.png (dialog).

## 3. /sessions

Headed "Conversations". Search placeholder "Search conversations", filters "Agent", "Origin", "Running now" (verb phrase, kept). Rows read "Say hello and list three colours / Verifier Bot, UI, Done / Conversation". A conversation with no tasks shows "No tasks". Navigation landmark is "Conversations".

Screenshots: desktop-4.png, phone-4.png.

## 4. Conversation page

Breadcrumb "Desk > Conversation" (desktop; the phone layout drops it). Controls: "Rename conversation", "Pin conversation" and "Unpin conversation", "Archive conversation" and "Unarchive conversation". All toggled and restored without error. Rename opens a textbox named "Conversation name". The reply note reads "Sending starts task N in this conversation".

I sent two replies to make a 3-task conversation (and a 2-task one on the phone). The picker button reads "Task 3 of 3" (phone shows "3/3" with the accessible name "Task 3 of 3"). The menu lists "Task 1", "Task 2", "Task 3" with status and first words. Dividers in the thread read "Task 2 of 3", "Task 3 of 3 · this task". The phone 2-task conversation showed "Task 1 of 2" and "Task 2 of 2 · this task". The tab list has the aria name "Task"; the tabs are "Conversation", "Files", "Log". The header line shows "not reported this task" (cost note).

Screenshots: desktop-5.png (page), desktop-6.png (picker open), phone-5.png (page), phone-6.png (picker open).

## 5. Agent profile

"Runs on a test runner", "Run now" (verb, kept). Conversations card: "Open main conversation", "New conversation" (opens the same New conversation dialog with the agent preselected), list of conversations, "All conversations". Recent tasks card: "Recent tasks", rows by first message with the reply under each, "All tasks". "Open main conversation" opens an empty conversation ("Nothing in this conversation yet.", "Sending starts task 1 in this conversation"). "All conversations" and "All tasks" both go to /sessions?agent=<id>, headed "Conversations".

Screenshots: desktop-7.png (Agents list, "Tasks this week" column), desktop-8.png (profile), phone-7.png (Agents list), phone-8.png (profile scrolled to the Conversations and Recent tasks cards).

## 6. Spot-check of other pages

Both sizes: /desk (board and list), /log, /map, /routines, /triggers, /qa, /inbox, /library, /artifacts, /skills, and all eight /settings pages. I also opened the Create routine and Create trigger dialogs, and the "Run now" dialog from the profile.

Good: Desk board "+ New conversation"; Map "Tasks · last 7 days", "3 tasks · Test runner"; Log rows "Task K9YD2JZD"; Inbox keeps "New thread" and "No threads yet" on purpose; the Create trigger dialog says "start a task for an agent over HTTP"; Run now opens the New conversation dialog; Agents table header "Tasks this week". Verbs and "run on" phrasing (Agents run on, Runs on, Run now, Running now, "routine runs") are as expected.

Screenshots: desktop-9.png and phone-9.png (Desk board), desktop-10.png and phone-10.png (Routines), desktop-11.png and phone-11.png (Library), desktop-12.png and phone-12.png (Settings, Artifacts).

## Wrong wording and notes

1. /triggers empty state (apps/web/src/routes/_app/triggers.tsx, around line 118) reads "No triggers yet. Create one to let an outside system start an agent run over HTTP." This uses "run" as a noun and disagrees with the Create trigger dialog ("start a task"). Should be "start a task".
2. /log shows raw event identifiers (`run.queued`, `run.finished`, `run.dry_run_skipped`, `script.run`) in the filter and rows. These look like technical event names, not prose, so I left them out of the defect count; Dom may want to decide.
3. "All tasks" on the profile links to a page headed "Conversations". Reads slightly off, but both cards share the link target.
4. An empty main conversation has an empty h1 (its page shows the agent name only as a paragraph). Pre-existing, noted with the Find entry above.

No "session" or "agent thread" wording was visible anywhere in the pages walked.

## Console and network

Console: no errors on any page at either size. Only expected output: Vite debug lines, the React DevTools info line, the Clerk development-keys warning and a WebGL fallback warning (environmental). Network: no response with status 400 or above in resource timing for any page, and no "Failed to load resource" console lines. The dev server log shows only the Clerk warning and the migration table; no server errors. The 401 before sign-in on /login was not counted.

## Cleanup

Dev server stopped (PIDs 1136960 and 1140294, port 3117 free). The browser session was closed. Logs and helper scripts are in /home/roboto/devel/harbourmaster-wt/tmp/NV.1/. The local D1 now holds the test agent and a few conversations (local only).
