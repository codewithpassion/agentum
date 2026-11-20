# SP.4 browser verification

Verdict: PASS. Flows A to F work at 1280x800 and 390x844 with figures that match the hand sum. The only console error and non-2xx response is one 409 Conflict, from deliberately starting a task on a paused agent (flow E), which is the designed rejection. Observations that are not failures are listed at the end.

Setup: proof checkout `SP.4-proof` (SP.4 plus SP.3), vite on port 3417, agent-browser session `sp4-verify`, dev login. Workspace timezone UTC, today Fri 20 Nov 2026, so "this week" starts Mon 16 Nov. Two agents, Alpha Agent and Beta Agent, were created through `agents.create` tRPC with runtime `fake` (the dev echo runtime, not `cloud`) and each ran one task through Run now. Then 11 runs were seeded straight into local D1 by cloning a finished run.

Seed (usage `{"costUsd": x}`, created_at 10:00Z): Alpha 19 Oct week 1.50, 26 Oct week 0.75, 2 Nov week 3.00, last week 2.00, this week 1.25 + 0.50 (a dry run of 9.99 on 19 Nov must be ignored). Beta 2.25, 1.00, none, 4.00, 0.40. The fake runs themselves report no cost.
Hand sums: Alpha 1.50 / 0.75 / 3.00 / 2.00 / 1.75, Beta 2.25 / 1.00 / 0 / 4.00 / 0.40, totals 3.75 / 1.75 / 3.00 / 6.00 / 2.15.

## Flow A: top bar and Find
- Desktop: Spend link sits between Files and Find (desktop-01). Click goes to /spend (desktop-02). Ctrl+K, type "Spend": option "Spend Cost and weekly limits" is first (desktop-04); Enter on it opens /spend.
- Phone: bar shows Home, bell, Menu. Spend is in the Menu sheet (phone-02) and opens /spend (phone-03). Menu > Find > "Spend" lists the same option (phone-07) and opens /spend.

## Flow B: /spend
- Desktop (desktop-02): five bars Oct 19, Oct 26, Nov 2, Last week, This week (this week orange, last), value labels $3.75 $1.75 $3.00 $6.00 $2.15. Hover over the Last week bar shows a tooltip "Last week $6.00" (desktop-03). Table has one row per agent, five week columns, Limit, Total row. Every cell equals the hand sum, including this and last week. The dry run and the cost-less fake runs are not counted. Limit column reads "None".
- Phone (phone-03, phone-04 full page, phone-05 tooltip, phone-06 table scrolled): same bars and labels, tooltip shows on touch/hover. The table is wider than the screen (469px vs 358px) and scrolls inside its own container, so "This week" and "Limit" start off-screen; the page itself does not scroll sideways (scrollWidth 390). The agent column is not sticky.
- Dashed workspace limit line: see flow C.

## Flow C: workspace limit
- Desktop: /settings/spend (desktop-05), 50 then Save shows "Saved." (desktop-06). Reload shows 50. /spend says "Workspace: $2.15 of $50 this week." and the chart has a dashed "Workspace limit $50" line (desktop-07). "Set a limit" on /spend goes to /settings/spend. Empty value then Save shows "Saved." (desktop-08), and /spend returns to "No workspace limit is set." with no line.
- Phone: phone-08 (form), phone-09 (Saved.), reload keeps 50, /spend line and text in phone-10. Cleared again afterwards, /spend back to "No workspace limit is set."

## Flow D: agent limit
- Desktop: no limit yet: Home cards show "$1.75 this week" and "$0.40 this week" (desktop-01 area, text checked), Beta header shows no spend pill (desktop-13). Settings tab "Weekly spend limit" (desktop-09), 20 then Save shows "Saved." (desktop-10). Header pill "$1.75 of $20 this week" (desktop-11). Home card "$1.75 of $20 this week" (desktop-12), Beta card still plain "$0.40 this week".
- Phone: cleared the limit first (Saved.): header has no pill (phone-12), card "$1.75 this week". Set 20 (phone-13 Saved.): header "$1.75 of $20 this week" (phone-14), card "$1.75 of $20 this week" (phone-15). phone-11 is the header before the clear.

## Flow E: pause and resume
Limit $0.50 on Alpha (spent $1.75), then Run now with "run to hit the limit", the run finished as Done.
- Desktop: Home card "Paused. Weekly limit reached", "$1.75 of $0.50 this week", red dot, "Paused at its weekly limit" chip under Needs you (desktop-14). Agent header: pill "$1.75 of $0.50 this week" plus a red "Paused. Weekly limit reached" pill (desktop-15). Needs you drawer: item "Paused at its weekly limit / Alpha Agent stopped at its weekly limit" (desktop-16); opening it goes to /desk?item=... with "The limit is $0.50 a week.", Resume and Raise the limit (desktop-17, desktop-18). The Board lane (/desk?view=board) shows the item card with both buttons (desktop-28).
- Start another task on the paused agent: New conversation dialog stays open and shows in red "Alpha Agent is paused. Its weekly limit was reached." (desktop-19). Network: one 409.
- /spend while paused: Alpha row has a "Paused" tag and Limit $0.50 (desktop-20). Figures unchanged (F, desktop).
- Resume: item and chip disappear, "Nothing needs you" (desktop-21, desktop-22), agent paused_at cleared, limit stays $0.50, card back to Idle.
- Paused again by another run. Raise the limit opens one input "New weekly limit in dollars" prefilled with the current limit "0.5" (desktop-23). Empty then Raise and resume: "Enter the new limit in dollars." (desktop-24). "abc": "Enter a dollar amount above zero, like 20 or 12.50." (desktop-25). 20 then Raise and resume: item gone (desktop-26), agent resumed, Settings tab Weekly limit = 20 (desktop-27).
- Phone: same sequence. Limit 0.5 set, run, Home card paused with chip (phone-16), header Paused pill (phone-17), drawer item (phone-18), /spend row "Paused" with Limit $0.50 (phone-19). Start on paused agent shows the same red message (phone-20). /desk?item (phone-21) and Board lane with Resume and Raise the limit (phone-22). Resume clears it (phone-23), agent Idle. Paused again, Raise opens input (phone-24), empty message (phone-25), "abc" message (phone-26) same texts as desktop, 20 resumes (phone-27), Settings shows 20 (phone-28).

## Flow F
/spend after pause shows the agent row with "Paused" tag and the limit, at both sizes (desktop-20, phone-19). The tag is gone after Resume/Raise.

## Console and network
- Console errors: one in total, `Failed to load resource: ... 409 (Conflict)`, from starting a task on the paused agent (flow E, both sizes). Expected rejection, not a defect.
- One `400` console error showed once right after the first dev-login redirect, before any SP.4 page (resource not identified; the Clerk dev instance is the likely source). It did not come back on any later page load.
- No page errors. No failed same-origin resource loads (Resource Timing status check after each flow). favicon 404 ignored.

## Observations (not failures)
- Raise the limit prefills the current limit; submitting it unchanged is accepted and resumes the agent at the same limit (the agent pauses again on its next task).
- Phone /spend table needs a sideways scroll inside its container; the Alpha/Beta names scroll out of view.
- A zero week shows "$0" in the table, other cells show "$x.xx".
- Needs you item title is "Paused at its weekly limit" with the subtitle "<name> stopped at its weekly limit" in the drawer; the lane card title is "<name> stopped at its weekly limit".
- Agents were created with the `fake` runtime, not `cloud`.
