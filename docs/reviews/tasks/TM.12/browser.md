# TM.12 browser verification

Verdict: pass. The proposal card shows what the lead proposes and works from the room at both sizes. Every flow passed. Three wording defects remain outside the card itself (listed below). One server 500 came from the test harness, and a clean rerun had no failed requests.

Build: branch `task/TM.12-the-lead-s-proposal-card-says-what-it-pr`, head acf4861. Dev server `bunx vite dev --port 3447` in `apps/web`, local D1, stopped after the run.

## Setup

- Signed in by opening `/api/dev-login` directly.
- Seeded `lead-ann` (Lead Ann), `writer-bo` (Writer Bo, id `01M7X7RJF32DSVPVWDBKJ43MMN`) and `checker-cy` (Checker Cy) with `scripts/dev/seed-fake-agent.ts`.
- Created team "Proposal desk" in the New team dialog with all three agents and Lead Ann as lead. No rules were set.
- Opened the room and made one topic, "Plan launch", open to the whole team. Posted "Please draft the launch note." Lead Ann answered once (fake echo). The room then had a single topic and a single lead run, so every proposal card landed in the topic that was open.
- Before each proposal I left the page on `about:blank` and then ran `scripts/dev/team-propose.ts --lead lead-ann --agent <writer-bo id> ...`. I checked the result with sqlite3 only when no page was loaded.

## Flows

| # | Flow | Desktop 1280x800 | Phone 390x844 |
|---|---|---|---|
| 1 | Instructions proposal: read the card in the room | Pass. The card shows the heading "Lead Ann proposes a change to Writer Bo", "expires in 72 h", Field "Instructions", Now "Echoes whatever it is told." (the member's current instructions), Proposed (the new text), Reason, an optional "Note for Reject" box, and the buttons Approve and Reject only. The page has no "Always allow" text and no `<details>` (no raw JSON Input). `desktop-1.png` | Pass. Same content. The card is 330px wide inside a 390px viewport and the document scrollWidth is 390. `phone-1.png`, `phone-2.png` |
| 1a | Same card in Needs you and on `/desk?item=<id>` | Shown in both. Needs you lists it as "Writer Bo asks before team propose change". The desk page heading uses the same old wording, but the card body is the new proposal card. `desktop-1-needs-you.png`, `desktop-1-desk.png` | Not repeated at phone size |
| 1b | Approve from the room | Pass. The card settles to "Allowed once by Dev User in the web app". In the DB the request is `allow_once`, and writer-bo's instructions are the proposed text. The agent page Settings tab shows the new instructions. `desktop-2.png`, `desktop-3.png` | Pass. I approved a 1118-character proposal. The settled line is the same. The agent page Settings textarea holds all 1118 characters. `phone-4.png`, `phone-7.png` |
| 2 | Effort or model proposal, Reject with a note | Pass. Effort default to low, note "Keep default effort for now; ...". The card settles to "Denied by Dev User in the web app: <note>". In the DB the request is `deny` with the note, and writer-bo's `runtime_config` is still `{}`. In the clean rerun I rejected a model proposal (fake to claude-haiku-4-5) with a note: model still `fake`. `desktop-4.png`, `desktop-5.png`, `desktop-6.png`, `desktop-7.png` | Pass. Effort default to low, note "Not now, keep default effort.". It settled as Denied with the note and the member was unchanged. `phone-5.png`, `phone-6.png` |
| 3 | Phone layout with a long value | n/a | Pass. No horizontal overflow (scrollWidth 390). Approve and Reject are each 306x40 px, full card width and stacked, and an elementFromPoint hit-test reaches the button. The long Proposed value is a `<pre>` with max-height 192px, overflow auto and overflow-wrap anywhere (scrollHeight 432). A mouse wheel over it scrolled the block by 150px while the page scrollY stayed at 910. A long unbroken URL token wraps inside the card. `phone-3.png`, `phone-3-scrolled.png` |

## Defects and oddities

1. The room wraps the card in a heading "Writer Bo needs you" (`components/room/room-requests.tsx:123`, which uses the request's `agentId`, the target). It names the target as the one who needs you, right above "Lead Ann proposes a change to Writer Bo". This is the same confusion the task fixed inside the card.
2. Needs you and the `/desk?item=<id>` heading still say "Writer Bo asks before team propose change", and the desk's "How it got here" says "Writer Bo started this". Only the card body changed.
3. The settled lines say "Allowed once by ..." and "Denied by ...", but the buttons were Approve and Reject, and the settled line does not say what was approved or rejected.
4. Minor: at phone size the buttons are 40px tall, a little under the usual 44px touch target. The sticky composer (about 190px, already known from TM.10) covers the lower part of the card until you scroll.

## Console and network

- Browser console: no errors in any flow. The only warnings were Clerk dev keys and the React DevTools notice. `agent-browser errors` was empty.
- Browser requests: after each flow I checked `PerformanceResourceTiming.responseStatus` on the page (with the buffer raised to 10000) and found no 4xx or 5xx responses. That covers the Approve and Reject mutations and the polling.
- Server log, harness-induced:
  - One `tRPC desk.rail failed` (SQLITE_BUSY). It happened when I ran `team-propose.ts` twice by mistake while the agent page was open and polling. It was not repeated in the clean desktop rerun.
  - `Slack request card failed ... database is locked` was logged on 4 of 6 `team-propose.ts` runs, including runs with no page open. The script holds the local SQLite file while the server posts the Slack card, so this is the script and not the app. TM.10 saw the same thing.
- The duplicate mistake left two effort cards. I rejected one at desktop size and one at phone size.
