# TM.10 browser verification

Verdict: pass after the follow-up round below. The first verifier could not exercise the two hidden-from-non-member checks in the UI because only one person can sign in. The follow-up round did, by having the lead open a topic that leaves the signed-in person out (see the last section). Defects found are listed in `docs/reviews/TM-e2e.md` as proposed tasks.

Setup: dev login via GET /api/dev-login (the /login page never reached networkidle, so I opened the route directly). Seeded lead-ann/writer-bo/checker-cy (desktop) and lead-pat/writer-quin/checker-rae (phone).

Flows (desktop 1280x800 team "Desk wide", phone 390x844 team "Desk phone"; screenshots desktop-<n>.png, phone-<n>.png):
1. Team with three agents and a lead created in the New team dialog; rules "@writer-bo @checker-cy" saved. There is no "lead listens" checkbox, only the sentence "The lead hears room messages that name nobody". Pass, with that oddity.
2. Post without mention: lead echoed, lead post shows "Assigned to Writer Bo, Checker Cy" and a Task chip; both members woke and replied with Task chips. Chip opens /threads/<id>. Pass at both sizes.
3. "@checker-cy" post: checker replied, lead did not. The checker's echoed input holds <untrusted-thread-posts> with earlier posts. Pass. (Echo cascade makes members wake each other, expected with the fake runtime.)
4. team-propose.ts gives pending requests. They appear in Needs you and /desk?item=<id> as "<Writer> asks before team propose change". Allow once: instructions changed (agent page and DB). Deny: unchanged, request answered. --field connectors is refused with a validation error (expected one of instructions|model|effort|contextBudget). Pass at both sizes.
5. Limited topic (excluding checker): mention of the excluded agent did not wake it (no reply), the lead of the topic still heard unmentioned posts. Non-member hiding was first covered by service tests only (one person can sign in); the follow-up round at the end exercised it in the UI. Service tests: `bun test packages/services/src/inbox.test.ts -t limited` 4 pass: "a limited topic is hidden from everyone who is not in it", "a limited topic's member agent is woken and can read it", "the runs of a limited topic are visible only to its members", "a lead outside a limited topic does not hear it".
6. Task chip opens a task page at both sizes. Hidden-run case was exercised in the follow-up round at the end; also covered by service test "a post shows its run only to a reader who may see that run" passes.

Defects and oddities:
- Approval card for a lead proposal is the generic permission card: title names the target agent ("Writer Bo asks before team propose change"), buttons are Allow once / Always allow / Deny, and field, value, reason and lead name are only inside a collapsed raw-JSON "Input". "Always allow ... Saves a rule if one fits" is offered for a config change. Not shown inline in the room task. (apps/web/src/components/requests/request-card.tsx)
- In a limited topic the lead post says "Assigned to Writer Bo, Checker Cy" although Checker Cy is not in the topic and was never woken.
- Phone: the composer is sticky and takes about 200px of 844px, clipping the last Task chip; topics sheet stays open after "New topic" creation closes only the dialog (sheet remained until a topic was tapped).
- Console: 2 tRPC 500s (inbox.listThreads, inbox.readThread) and a "Slack request card failed" log, all SQLITE_BUSY/"database is locked", coinciding with team-propose.ts and my sqlite3 CLI reads of the same local D1. Likely harness-induced, not proven. A 400 on /__tsd/open-source is the devtools source-opener. Warnings only otherwise (Clerk dev keys, WebGL).

## Follow-up round: hidden from a non-member, in the UI

The lead (lead-ann) opened a topic "Agents only" with writer-bo as the only other member, through `bun scripts/dev/team-propose.ts --tool team_open_topic`. The signed-in person is not a member of it. The lead then posted `@writer-bo please draft the secret plan` there, which started a run for writer-bo in that topic.

| Check | Desktop 1280x800 | Phone 390x844 |
|---|---|---|
| The room's topic list | Shows "Private draft" and "Plan launch" only. "Agents only" is absent. Screenshot `desktop-limited-hidden.png`. | Same list. `phone-limited-hidden.png`. |
| Opening `/teams/<id>/room?thread=<agents-only id>` | Lands on the room with "Pick a topic", no posts. | Same. |
| Opening the run's task page `/tasks/<run id>` | "Task not found. This task does not exist, or you cannot see it." `desktop-limited-task-hidden.png`. | Same. `phone-limited-task-hidden.png`. |

No console errors in this round apart from the devtools source opener 400. The two 500s in round one were SQLITE_BUSY while the script and a sqlite3 read held the local database, and did not recur.
