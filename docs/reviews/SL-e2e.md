# SL end-to-end: one Slack channel for a team room

Task SL.5. The local walkthrough runs against a fake Slack and passes, in process and in a browser (`docs/reviews/tasks/SL.5/browser.md`). The staging walkthrough with a real Slack workspace is written below and is waiting on Dom.

## Local result

The whole link runs on a local fake Slack, in both directions, with three member apps. It passes in two ways.

`apps/web/src/server/slack-room-flow.test.ts` runs it in process. Slack's signed events reach the real events route, the three agents run on the fake runtime, and their posts go out through the real Slack client to the fake. It covers linking and the missing-app status, one post for a message every app hears, thread to topic, a guest, a mention, the lead hearing an unaddressed message, an agent post through its own app, a person's post through the lead's app with their name, the fallback to the lead's app, no echo of the apps' own messages, a request card in the topic's Slack thread with a signed click that answers it, `slack_history` and `slack_search`, and an unlinked channel keeping the old path.

A fresh verifier then drove the real app in a browser against the same fake, at 1280x800 and 390x844, and passed all six flows at both sizes (link, Slack to room, thread and guest, mention, Agentum to Slack with the fallback, unlink). It saw no console error and no failed request. The report and 36 screenshots are in `docs/reviews/tasks/SL.5/`. The approval card and the two agent tools cannot be walked in a browser, because the fake runtime never asks for approval. The in-process test covers them.

To run it again, from the repo root, in this order. The app needs `VITE_FAKE_SLACK_URL`, which only a dev build reads.

1. `cd apps/web && bunx wrangler d1 migrations apply DB --local`
2. `VITE_FAKE_SLACK_URL=http://127.0.0.1:5199 bunx vite dev --port 5191` in `apps/web`
3. `bun scripts/dev/fake-slack.ts --app-url http://localhost:5191 --port 5199`
4. Open `http://localhost:5191/api/dev-login` once, then `bun scripts/dev/seed-slack-room.ts`. It makes the "Launch" team, three agents with their apps, and the identity link for the dev user. It reads the dev user's Clerk id and creates no Clerk user.
5. Open `http://localhost:5199/` to write in the channel as Dev Person or Gus Guest, invite or remove an app, and press card buttons.

### The SL.2 questions

SL.2 moved linked-channel messages out of `slack_messages` and stored a Slack guest as a user post with author id `slack:<teamId>:<userId>`. Two things followed.

- `slack_history` still works. It reads Slack live and never used `slack_messages`. Messages that a member app sent for a person show up with the app's bot id and the person's name in bold at the start of the text.
- `slack_search` was broken. It reads only `slack_messages`, so a linked channel returned nothing. It now also searches the room posts of a linked channel, for agents on that team, in topics open to the whole team, and only while the channel is still linked to that topic's team. A guest's name and label do not match a search word. The e2e test fails without the change.
- Guest posts rendered as "Teammate" with `<Name> (Slack guest):` in the body. The room now shows the guest's name, a muted "Slack guest" tag and the message alone.

## Fixed on this branch

- `slack_search` finds the messages of a linked channel (above).
- Guest posts read well in the team room (above).
- A dev build can point Slack's Web API at a local fake (`apps/web/src/server/dev-slack-fetch.ts`). It needs a dev build and `VITE_FAKE_SLACK_URL`, so a deployed Worker never uses it.


## Waiting on Dom: staging with a real Slack workspace

Nothing in this section has run. It needs a Slack workspace you can create apps in, and a staging deploy of this branch (`bun run staging:deploy`, a controller or Dom step).

### Before you start

- Staging is `https://staging.agentumbot.io`. Sign in from `apps/web` with `bun run agent-login --env staging --redirect /teams`. It uses the Clerk dev instance and a user in Dev Workspace, so no new Clerk user is needed. For the person steps below, the Slack account must carry the same email as that Clerk user, that Clerk user must be a member of the team in Agentum, and the Slack profile email must be visible to apps. No link needs to exist beforehand: the first message links them.
- Two agents, called A (the lead) and B here, each with its own Slack app. Make each app from the manifest on the agent's Slack tab (Slack's "Create app from manifest"), install it in the test workspace, and paste its Signing Secret and Bot User OAuth Token. Use the manifest from this build: it subscribes to `app_mention`, `message.channels`, `message.groups` and `message.im`, and sets the events URL (`/api/slack/events`) and the interactivity URL (`/api/slack/interactions`) on staging. An app made from an older manifest lacks the channel message events, so the room hears nothing; reinstall it from the new manifest.
- A third Slack account that is a member of the test workspace but has no Agentum account (the guest in step 7). Its email must not match any Agentum user in the organisation.
- A Slack channel `#sl-test`. Invite only A's app to it for now (`/invite @A`).
- A team "SL test" in Agentum with A as lead, B as a member, and your Agentum user as a member. Leave "lead listens" on.
- Give B an ask-before rule for one tool, so it asks for approval (agent page, "Ask me before it...", level "everything" does it). You need this in step 10.

### Steps

Each step names what to do and what you should see.

1. Open the team page `/teams/<id>`. Under Slack pick `#sl-test` and press Link channel. You see "Linked to #sl-test". B is listed with the line `/invite @<B's bot name>`, because B's app is not in the channel. The room header reads "Slack #sl-test".
2. Paste that line in `#sl-test` in Slack, reload the team page. B leaves the list and the page says "Every agent's Slack app is in the channel."
3. In Slack, post "Kickoff: plan the launch" as yourself. This is your first message from that Slack account, so it also creates your identity link, and the post is by you, not a guest. In the team room you see one new topic with that title and one post by you, not one per app. Within a few seconds A answers, and its answer appears in the Slack thread of your message, sent by A's app. B does not answer.
4. Reply inside that Slack thread ("Also check the budget."). The room shows it as a second post in the same topic, and A answers once more in the thread.
5. Post in the thread a real mention of B: type `@` and pick B's app, then "what do you think?". The room shows the post with `@<B's slug>`, B wakes (a run appears on B's page) and B answers in the Slack thread under B's own app name. A does not answer this one.
6. Check the channel has no duplicate of any message and the room has no second copy of A's or B's answers. Bot messages from the apps never come back as room posts.
7. From the Slack account with no Agentum link, post "Can I join the launch?" in the same thread. The guest sees one private reply in the thread ("I don't know you yet. Ask an Agentum admin...", only they see it), and a second message from them gets no second reply. The room shows the post under that person's Slack name with a muted "Slack guest" tag and the text without the "(Slack guest):" prefix. No agent wakes. Post a top-level message from the same account: it opens its own topic, and the topic list shows its title. A person from another Slack organisation in a shared channel (Slack Connect) is never linked by email and stays a guest, with no reply.
8. In the room, open the Kickoff topic and write "Please send the draft." as yourself. In Slack you see a reply in the thread, sent by A's app, starting with your name in bold. The room does not get a second copy. A then answers in the thread.
9. In the room write "@B please review the budget." B's answer appears in the Slack thread under B's app.
10. Approval card. In that topic ask B for something that needs the tool you gated, for example "@B send the summary mail". B's card (Allow once, Always allow, Deny) appears in the Slack thread of the topic, sent by B's app, not as a direct message. Press Allow once as yourself. The request closes in Agentum (Needs you drawer empties, the task continues), and the card in Slack changes to "Allowed once". Repeat with a second request and answer it in Agentum instead: the Slack card settles. Press a button as the unlinked Slack account: you get an ephemeral "You can't answer this one." and nothing changes in Agentum.
11. In Slack run `/remove @B` in the channel. Reload the team page: B is listed again with its `/invite` line. In the room write "@B are you there?". B's answer reaches Slack through A's app, starting with `*B:*`. Invite B again afterwards.
12. Failure item. On A's agent page replace the Slack bot token with a wrong one (or revoke both apps), then post in the room. Nothing reaches Slack, and the team owner sees "Slack is missing <team> messages" in Needs you. Restore the token, post again, and the item goes away.
13. Agent tools. Ask B in the room: "Search Slack for Kickoff, then read the channel history of #sl-test." The search answer lists your Kickoff message (this reads the room, since the channel is linked and B is on the team) and the history answer lists the channel's messages, with the apps' messages marked as bots. B must be in the channel.
14. Press Unlink on the team page. The picker returns. Post in `#sl-test`: nothing reaches the room, and a mention of A or B gets today's per-agent Slack behaviour.

### What to write down

For each step: pass, or what you saw instead. Also note how long A's answer takes to appear in Slack (the room send runs after the response), and whether Slack showed any duplicate message or a missing one. Report a failure with the step number, the channel link and the time, so the Worker log for that minute can be read.

### Things this run cannot tell you

- The fake Slack answers every Web API call and signs every event, so nothing here shows that Slack accepts the manifest, the scopes or the interactivity URL. Steps 1, 2, 3 and 10 are those checks.
- Slack Connect channels and files in room messages are not built (a message with files and no text is dropped).

## Findings and proposed tasks

These are larger than a fix, so none is built here.

### SL.6 A fake runtime that asks for approval in a room

Finding. The browser walkthrough cannot show the approval card in a Slack thread, because the fake runtime only echoes. The card path is covered in process only.

Scope. A fake mode chosen by a marker in the task text (for example `ask:<tool>`) that opens an approval request for the run, waits for the answer, and then replies with the decision. It registers only when `devFakeRuntime` is true.

Check. A run test for the mode. Browser: post `@ada ask:send_email` in a linked room, see the card in the fake Slack thread, press Allow once there, and see the request close in Agentum and the card settle.

### SL.7 A guest author kind

Finding. A guest is a user post with the name inside the text, and the room and `slack_search` each parse the `(Slack guest):` prefix. That is two copies of a convention nothing enforces. A topic a guest opens also stores the guest id in `created_by`.

Scope. A contract task adds a `guest` author kind or a `guest_name` column on `inbox_posts`, `postExternal` writes it, and the two readers use it. Existing rows are migrated by splitting the prefix.

Check. Migration test on rows with the prefix. Room and search tests no longer parse text.

### SL.8 Slack markup both ways

Finding. Room text keeps raw Slack markup (`<@U123>`, `<#C123|name>`, `<https://x|label>`). Agentum text goes out as written, so `@name` is plain text and markdown is not mrkdwn.

Scope. Convert Slack user, channel and link markup to readable text on the way in, and `@slug` and markdown to Slack mentions and mrkdwn on the way out.

Check. Unit tests for both converters. Browser with the fake: a message with a mention and a link reads cleanly in the room, and an `@ada` in a person's post goes out as a real mention.

### SL.9 A sweep for lost room work

Finding. The room wake (SL.2) and the room send (SL.3) both run in `waitUntil` with no backup. A lost job loses that wake or that message, and nothing retries it.

Scope. A minute-tick job that wakes the lead for room posts no wake has seen, and sends posts in a linked room that have no `out` row.

Check. Tick test that drops the deferred job and sees the sweep finish the work once.
