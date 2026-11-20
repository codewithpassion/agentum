# SL end-to-end: one Slack channel for a team room

Task SL.5. The local walkthrough is done against a fake Slack, and a fresh verifier drove it in a browser at 1280x800 and 390x844: `docs/reviews/tasks/SL.5/browser.md`. The staging walkthrough with a real Slack workspace is written below and is waiting on Dom.

LOCAL_RESULT_PLACEHOLDER

## Waiting on Dom: staging with a real Slack workspace

Nothing in this section has run. It needs a Slack workspace you can create apps in, and a staging deploy of this branch (`bun run staging:deploy`, a controller or Dom step).

### Before you start

- Staging is `https://staging.agentumbot.io`. Sign in from `apps/web` with `bun run agent-login --env staging --redirect /teams`. It uses the Clerk dev instance and a user in Dev Workspace, so no new Clerk user is needed. For the person steps below, the Slack account must carry the same email as that Clerk user, because the app links a Slack user to an Agentum account by email.
- Two agents, called A (the lead) and B here, each with its own Slack app. Make each app from the manifest on the agent's Slack tab (Slack's "Create app from manifest"), install it in the test workspace, and paste its Signing Secret and Bot User OAuth Token. Use the manifest from this build: it subscribes to `app_mention`, `message.channels`, `message.groups` and `message.im`, and sets the events URL (`/api/slack/events`) and the interactivity URL (`/api/slack/interactions`) on staging. An app made from an older manifest lacks the channel message events, so the room hears nothing; reinstall it from the new manifest.
- A third Slack account that is a member of the test workspace but has no Agentum account (the guest in step 7).
- A Slack channel `#sl-test`. Invite only A's app to it for now (`/invite @A`).
- A team "SL test" in Agentum with A as lead, B as a member, and your Agentum user as a member. Leave "lead listens" on.
- Give B an ask-before rule for one tool, so it asks for approval (agent page, "Ask me before it...", level "everything" does it). You need this in step 10.

### Steps

Each step names what to do and what you should see.

1. Open the team page `/teams/<id>`. Under Slack pick `#sl-test` and press Link channel. You see "Linked to #sl-test". B is listed with the line `/invite @<B's bot name>`, because B's app is not in the channel. The room header reads "Slack #sl-test".
2. Paste that line in `#sl-test` in Slack, reload the team page. B leaves the list and the page says "Every agent's Slack app is in the channel."
3. In Slack, post "Kickoff: plan the launch" as yourself. In the team room you see one new topic with that title and one post by you, not one per app. Within a few seconds A answers, and its answer appears in the Slack thread of your message, sent by A's app. B does not answer.
4. Reply inside that Slack thread ("Also check the budget."). The room shows it as a second post in the same topic, and A answers once more in the thread.
5. Post in the thread a real mention of B: type `@` and pick B's app, then "what do you think?". The room shows the post with `@<B's slug>`, B wakes (a run appears on B's page) and B answers in the Slack thread under B's own app name. A does not answer this one.
6. Check the channel has no duplicate of any message and the room has no second copy of A's or B's answers. Bot messages from the apps never come back as room posts.
7. From the Slack account with no Agentum link, post "Can I join the launch?" in the same thread. The room shows the post under that person's Slack name with a muted "Slack guest" tag and the text without the "(Slack guest):" prefix. No agent wakes. Post a top-level message from the same account: it opens its own topic, and the topic list shows its title.
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

PROPOSED_PLACEHOLDER
