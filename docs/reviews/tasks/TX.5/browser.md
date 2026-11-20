# TX.5 browser verification

Commit e5377780, branch task/TX.5-decision-queue-card. Dev server on port 5391, dev login, agent-browser session tx5-verify, desktop 1280x800 and phone 390x844. Fake agent fake-echo, room topic "Launch plan" in the Everyone team, plus a second conversation "second chat".

## Verdict: pass, with two observations for the controller to rule on

Every flow (A to E) worked at both sizes. No console error and no failed request came from the feature. Two things did not match the brief literally, listed under Observations.

## Observations

1. The settled text "All answered" and "Dismissed" never showed on screen. After the last Send, or after Dismiss, the item left Needs you at once (count dropped), and in the conversation the card was replaced by "Answered by Dev User in the web app at 16:38". A MutationObserver on document.body, installed before each completing click (desktop and phone, desk and conversation), never saw either string. The code sets them (decisions-card.tsx, SETTLED_TEXT) but the parent unmounts the card in the same tick (`onClosed`). Behaviour is right, the transient card state is just not visible. Dismiss was confirmed in the database (run_requests.status = cancelled).
2. A free-text answer is saved but not shown again. After typing "Priya from legal" on question 3 and sending with other questions open, the database holds {"q1":"Ship it","q3":"Priya from legal"} and progress reads "2 of 3 answered" after reload, but the free-text input is empty and no button is pressed on that question (desktop-24.png). Option answers do show as pressed after reload. Likely in apps/web/src/components/requests/decisions-card.tsx or decisions-logic.ts (`pressedOption`, saved typed value).

Smaller notes. The /desk item pane titles the card "3 decisions" with "Fake echo" beneath; the text "Fake echo has decisions waiting" appears on the Needs you drawer row, not as a heading in the pane. Expiry line read "expires in 24 h" everywhere. Option buttons at phone width were 332 x 40 px, full width. No horizontal scroll at 390 (scrollWidth 390 = clientWidth) on /desk, the thread page and the room. One console 400 appears only on the Clerk dev-login redemption (/api/dev-login), reproduced on its own with no feature page involved, so it is app-wide and not TX.5. A first Send click right after typing free text, at phone width in the conversation, did nothing (button still disabled at that instant); a second click sent it. It looks like agent-browser acting before React re-enabled the button, not an app fault, but I did not prove that.

## Method for console and network

Console read with `agent-browser console` after each flow. The network log has no status codes, so failed requests were checked with performance resource entries (`responseStatus` other than 200/304), which returned an empty list after every flow. Only the dev-login 400 above showed.

## Flows at desktop (screenshots desktop-N.png)

A, Needs you pane. Opened /desk (desktop-1, shows an unrelated "Launch plan replied" item first), opened the Needs you drawer (desktop-2: row "3 decisions, Fake echo has decisions waiting"), opened the item (desktop-3: Decisions card, "expires in 24 h", "0 of 3 answered", buttons, free-text input on Q3, Send answers disabled, Dismiss). Pressed "Ship it": progress "1 of 3 answered", button pressed (desktop-4). Sent with only one staged: card stayed, progress "1 of 3", "Ship it" still pressed (desktop-5). Reload: still "1 of 3" and pressed (desktop-6). Chose Slack and Dom: "3 of 3", Send (desktop-7), item left, Needs you count 2 to 1 (desktop-8); the run resumed with the answers echoed. Also a --partial seed: after load "1 of 3", "Ship it" pressed (desktop-22).
B, Dismiss. Seeded another queue, opened it, pressed Dismiss (desktop-14, 15): card disabled during the call, item left, count 2 to 1 (desktop-16). "Dismissed" text not seen (observation 1).
C, Free text. On a --partial queue typed "Priya from legal" on Q3: "2 of 3 answered", Send enabled (desktop-23), sent, reload kept "2 of 3" but input empty (desktop-24, observation 2). Chose Slack, sent: "3 of 3", item left, count 2 to 1. Also done in the room (desktop-11, 12, 13): free text counted, sent, the echoed reply shows "Who signs it off?: Priya from legal".
D, Conversation inline. Opened /threads/01M7WX4AE4AFS854VPRFGQ277T: Decisions card inline above a "Waiting for your decisions" bar (desktop-17). Chose Hold a week, sent: "1 of 3", card stayed (desktop-18). Reload: "1 of 3", pressed (desktop-19). Chose Both and Dom (desktop-20), sent: card replaced by "Answered by Dev User in the web app", status Done, Needs you 2 to 1 (desktop-21).
E, Room post. /teams/<everyone>/room?topic=<Launch plan>: block "Fake echo needs you" with the Decisions card (desktop-9). Partial send of Hold a week: stays, "1 of 3" (desktop-10); after reload still "1 of 3", pressed. Completed with free text: card left the room, echoed reply posted (desktop-13).
How the room was made: Teams, Everyone, "New topic" with Fake echo ticked, then posted "@fake-echo hello from the room"; that starts an inbox task on the topic, which is what room-requests.tsx lists.

## Flows at phone (screenshots phone-N.png)

A. Seeded --partial, opened /desk?item=...: "1 of 3 answered", "Ship it" pressed, full-width 40 px buttons (phone-1). Drawer open (phone-2). Chose Email, sent: "2 of 3", both pressed (phone-3); reload: same (phone-4). Typed free text on Q3 (phone-5, "3 of 3"), sent: item left, count 2 to 1 (phone-6).
B. Seeded another, Dismiss (phone-7): item left, count 2 to 1 (phone-8). Database status cancelled.
C. Free text sent in A above.
D. /threads/<second chat>: card in the conversation (phone-9, phone-10 scrolled to the Send button), Slack chosen and sent: "2 of 3", reload kept both pressed (phone-11), free text typed (phone-12, first click did not send, see notes), second click sent: status Done, count 2 to 1, card replaced by the echoed answers (phone-13).
E. Posted "@fake-echo phone round" in the room, seeded, reloaded: "Fake echo needs you" card (phone-14, phone-15 are mid-scroll captures taken before the scroll settled, so the card looks cut off; phone-16 shows it whole). Hold a week sent: "1 of 3"; reload kept it pressed; Both and Dom sent: card gone, count 2 to 1, database answered with {"q1":"Hold a week","q2":"Both","q3":"Dom"} (phone-17).

Console and network: clean for every flow at both sizes except the unrelated dev-login 400.
