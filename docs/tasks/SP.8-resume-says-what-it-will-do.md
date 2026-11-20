---
id: SP.8
title: "Resume says what it will do"
milestone: SP
size: S
status: in_progress
depends_on: [SP.5]
branch: task/SP.8-resume-says-what-it-will-do
lane: web-spend
executor: claude
---

From the spend walkthrough (`docs/reviews/SP-e2e.md`).

When an agent is paused at $1.05 of a $1.00 cap, Resume (without raising the cap) clears the pause, the next run starts, and `enforceCap` pauses the agent again as that run ends. SP.3's spec lets a run through before the pause lands, and the card does not say so. It reads only "The limit is $1 a week." with Resume and Raise the limit. The owner who clicks Resume gets one run and a new Needs you card. A mail that arrived during the pause is stored and never run, and the notice does not tell the sender to send it again.

## Scope

the pause card shows the week-to-date next to the limit, "$1.05 of $1 this week". When the week-to-date is at or over the limit, the card drops Resume and offers Raise the limit alone. The mail notice adds "Send it again once the agent is resumed."

## Check

component tests for both card states. A mail service test that the notice carries the line. A browser pass at both sizes.

## Log
- 2026-11-21: added from the spend walkthrough.
- 2026-11-21: dispatched.
