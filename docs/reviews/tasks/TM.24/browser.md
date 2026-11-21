# TM.24 browser verification

Verdict: pass. Every flow works at 1280x800 and 390x844. No console errors. No 4xx/5xx seen in the browser.

Build: worktree TM.24, head f1545159. `bunx vite dev --port 3461` in `apps/web`, local D1, stopped after the run. Signed in with `/api/dev-login`.

## Setup

- `scripts/dev/seed-fake-agent.ts` made Lead Ana, Writer Bo (`01M7XY1BFN9NJGVPEMB2RY2YSM`) and Checker Cy.
- Team "Proposal desk" (Lead Ana as lead) made in the New team dialog. Topic "Plan launch" open to the whole team, one message, Lead Ana echoed.
- Page left on about:blank, then `scripts/dev/team-propose.ts` made four proposals (Writer Bo instructions).
- Plain approvals: no tool in the fake runtime asks for one, so I inserted four `run_requests` rows (kind approval, tool WebFetch, no `proposalOf`, agent Checker Cy) into the local D1 with sqlite3. They render as ordinary approval cards ("Fetch a web page", Allow once / Always allow / Deny).

## Flows

| # | Flow | Desktop 1280x800 | Phone 390x844 |
|---|---|---|---|
| 1 | Room heading over a pending proposal | Pass. Heading "Lead Ana needs you" over the card "Lead Ana proposes a change to Writer Bo". `desktop-1.png` | Pass. Same text, scrollWidth 390, buttons stacked full width. `phone-1.png` |
| 2 | Needs you list | Pass. Row "Lead Ana proposes a change to Writer Bo", sub-line "Needs your OK". `desktop-2.png` | Pass. Same row. `phone-2.png` |
| 3 | `/desk?item=<id>` | Pass. Heading "Lead Ana proposes a change to Writer Bo", card body, "How it got here" reads "Lead Ana proposed this Nov 21, 1:13 PM. Now: Needs your OK." No "started this", no "asks before team propose change". `desktop-3.png` | Pass. Same. `phone-3.png` |
| 4a | Approve in the room | Pass. Settled line "Approved by Dev User in the web app". `desktop-4.png` | Pass. Same line. `phone-4.png` |
| 4b | Reject in the room | Pass. "Rejected by Dev User in the web app: Not now." (note kept). `desktop-4.png` | Pass. "Rejected by Dev User in the web app". `phone-5.png` |
| 4c | Plain approval, contrast | Pass. Allow once gives "Allowed once by Dev User in the web app", Deny gives "Denied by Dev User in the web app". Unchanged wording. `desktop-5.png` | Pass. Same two lines. `phone-5.png`, `phone-6.png` |

Notes: the plain-approval cards use heading "Checker Cy needs you" (the agent that asks), as before. The desk page subtitle under the heading shows the target agent name "Writer Bo", the heading and "How it got here" name the lead. After a decision the desk item reads "That item is not waiting any more."

## Console and network

- `agent-browser errors` and console: no errors. Warnings only: Clerk dev keys, React DevTools notice, software WebGL notice, "No available adapters" (devtools).
- Browser requests: a clean reload of the room (250 resources) and of the desk item had no response status of 400 or above (PerformanceResourceTiming.responseStatus).
- Server log: one `tRPC inbox.readThread failed` (SQLITE_BUSY) and two `Slack request card failed` (database is locked). They coincide with my own sqlite3 insert and with `team-propose.ts` holding the local SQLite file while the page polled. Same harness effect as TM.12 and TM.10. A retry of the insert and the clean reload had no failure. I could not rule out that the browser saw that one 500 during my insert, since the performance buffer was not recording then.
