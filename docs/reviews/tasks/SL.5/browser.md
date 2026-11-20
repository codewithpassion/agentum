# SL.5 browser verification

Verifier: independent, did not build the feature. Branch task/SL.5-slack-link-e2e. Real app (`vite dev` on 5191, local D1) against the local fake Slack on 5199, signed in through `/api/dev-login`. Desktop 1280x800, then phone 390x844 after a fake restart and a re-seed. No Clerk users were created. No source was changed.

## Verdict

PASS. All six flows work at both sizes. No console error and no non-2xx request during any flow. Four minor notes are listed at the end; none blocks the task.

Not walkable in a browser and therefore not part of this verdict: the approval card in the Slack thread with its button click, and the agent tools `slack_history` and `slack_search`. They are covered by `apps/web/src/server/slack-room-flow.test.ts`.

## Results

| Flow | Desktop | Phone |
|---|---|---|
| 1 Link the channel | pass | pass |
| 2 Slack to room | pass | pass |
| 3 Thread reply and guest | pass | pass |
| 4 Mention | pass | pass |
| 5 Agentum to Slack | pass | pass |
| 6 Unlink | pass | pass |

Phone pages never overflowed: `document.documentElement.scrollWidth` was 390 on the team page, the room, the topics drawer, an open topic and the fake Slack page. Text was readable throughout.

## Flow 1, link the channel

Steps: opened the team page, picked "#sl5-room" in the "Slack channel" select, pressed "Link channel".
Saw: before linking, a "Pick a channel" select with a disabled "Link channel" button (desktop-1a, phone-1a). After linking, "Linked to #sl5-room" with an "Unlink" button, and "These agents' Slack apps are not in the channel yet. Paste each line in the channel in Slack:" with Di and `/invite @di` (desktop-1b, phone-1b). After `/_membership` for Di and a reload: "Every agent's Slack app is in the channel." (desktop-1c, phone-1c). The room shows "Slack #sl5-room" under the title "Launch" (desktop-1d, phone-1d; on phone the topic list sits behind a "Topics" button).

## Flow 2, Slack to room

Steps: Dev Person posted "Kickoff: plan the launch" (phone: "... (phone)") in the channel with `/_say`.
Saw in the room: a new topic with that title, one post by "You" with the text, one reply from Ada, no duplicate (desktop-2, phone-2; topic drawer phone-2a).
Saw in `/_state`: Ada's message has `threadTs` equal to the kickoff `ts`. Nothing from Cy or Di. Fake Slack page: desktop-2b, phone-2b.

## Flow 3, thread reply and guest

Steps: Dev Person replied in the thread ("Also check the budget."), Gus Guest replied in the thread ("Can I join the launch?"), Gus Guest posted top-level "Hello from a guest".
Saw: Dev Person's reply became a second "You" post in the same topic, answered by Ada. Gus Guest's reply rendered as author "Gus Guest" with a muted "Slack guest" tag, body exactly "Can I join the launch?", no "(Slack guest):" text, no avatar or label reading "Teammate" (the only "teammate" on the page is the composer hint). No agent replied to it. The top-level guest message created a new topic "Hello from a guest" (title is the message text) with one guest post and no agent reply. Screenshots: desktop-3, desktop-3b, phone-3 (guest post), phone-3b (topic list), phone-3c (guest topic).
Judgment: the guest post reads well. The initials avatar, bold name, small muted "Slack guest" tag and clean body make a guest easy to tell from teammates and agents. The topic title is the raw first message, which is fine for short messages.

## Flow 4, mention

Steps: Dev Person posted `<@U0CYLOCALBOT> what do you think?` in the thread.
Saw: the room post reads `@cy what do you think?` (mention converted) and Cy replied in the room. `/_state` has Cy's reply in the Slack thread, authored by Cy's app. Ada did not answer this one. Screenshots: desktop-4, desktop-4b, phone-4, phone-4b.

## Flow 5, Agentum to Slack

Steps: in the Kickoff topic wrote "Please send the draft." and sent it. Then removed Di's app (`member:false`), reloaded the team page, wrote "@di please review." in the room.
Saw: the room shows the post once. `/_state` has, in the Slack thread, a message from Ada's app starting `*Dev User:* Please send the draft.` (the dev user's name is "Dev User") followed by Ada's echo (desktop-5, 5b, phone-5, 5b). After removing Di the team page lists Di again with `/invite @di` (desktop-5c, phone-5c). `@di please review.` went out as `*Dev User:* @di please review.` from Ada's app, then Di's answer went out from Ada's app starting `*Di:*`. No message was ever authored by Di's own app (authors seen: Ada, Cy, Dev Person, Gus Guest). Screenshots: desktop-5d (room), desktop-5e (Slack), phone-5d, phone-5e.

## Flow 6, unlink

Steps: pressed "Unlink" on the team page, then posted "hello after unlink" as Dev Person.
Saw: the "Pick a channel" select and "Link channel" button came back (desktop-6a, phone-6a). After 12 seconds the room had no new topic, no new post, and no "Slack #..." line in the header (desktop-6b, phone-6b). `deliveryErrors` stayed empty.

## Errors, console and network

- Console after the setup phase, desktop pass: 0 errors, 0 failed requests (console cleared once after setup, then read after flow 6; also saved to tmp/SL.5/verify/console-desktop.txt).
- Console, phone pass (cleared after re-seed): 0 errors (tmp/SL.5/verify/console-phone.txt).
- Resource timing check for status >= 400 or 0 on the room and team pages: none.
- No request carried an author id starting with `slack:` in its URL (searched the full request log, 19843 entries on desktop and 31610 on phone). The `user:slack:T0SL5LOCAL:U0GUESTGUS` string appears only inside the text an agent receives as thread context, never in a request URL.
- `deliveryErrors` was empty after every flow at both sizes.
- fake.log has no errors. vite.log has one server error, from the setup phase only: a `tRPC desk.rail failed ... database is locked: SQLITE_BUSY` (HTTP 500 shown once in the console before I started the flows). It happened while `seed-slack-room.ts` wrote the same local sqlite file as the running dev server. It did not recur on the second seed or in any flow. Also one unattributed `400` console line from the setup phase (dev login). Both came before any flow step and I treat them as test-harness noise.
- Setup-phase `networkidle` waits time out (polling), so I used fixed sleeps.

## Notes (not failures)

1. The fake Slack page prints `&lt;untrusted-thread-posts&gt;` in agent replies, which is Slack escaping shown raw by the fake. Real Slack renders it as angle brackets.
2. The fake runtime's reply quotes the thread history, including `@cy` and `@di` text. That wakes the quoted agent, so after Ada's reply to "Please send the draft." Cy also answered ("Echo: Echo: ..."), and after "@di please review." Cy and then a second Di reply appeared (the second came out as `*Di:*` from Ada's app). The chain stopped by itself after two extra replies. This is fake-runtime echo behaviour, not a product fault.
3. In the topic list, the teal highlight marks unread topics, not the open one. The open topic has no separate selected style (desktop-3b, phone-3b).
4. A top-level guest message ("Hello from a guest") got no agent reply, while a top-level message from the linked person did. This looks intended (guest messages do not wake agents) but the spec does not say so.
5. Dev-only TanStack devtools button sits bottom right in every screenshot; it is not part of the product.

The topics from the desktop pass stay in the room during the phone pass (same team), so phone topic lists show both sets.
