---
id: ME.11
title: "Fix the cloud follow-up message for the scripted model"
milestone: ME
size: S
status: done
depends_on: [ME.9]
branch: task/ME.11-fix-the-cloud-follow-up-message-for-the
lane: runtimes
executor: claude
---

From the ME walkthrough (`docs/reviews/ME-e2e.md`).

A second message in the same cloud conversation comes back as an empty echo ("echo:") on the `faux` model. `bun scripts/e2e/cloud.ts --server http://localhost:<port>` fails at its second run ("expected \"echo: second message\", got \"echo: \""). The dispatcher ran this script, and a verifier saw the same empty echo in the browser (round 1). It happens on a branch that only changes the fake runtime and a Needs you component, so it should be on `main` too, but it was not run on `main` itself. A real model follows up correctly (a follow-up in a `mem-claude` conversation answered "Pineapple"), and the fake runtime echoes follow-ups correctly. So it is probably in the scripted model's path or the Durable Object's handling of a second run in a session, but the cause was not found and it was not bisected.

## Scope

Find the cause and fix it, or fix the faux model if it is only there. Check the run input the second run carries into `pi.submit`.

## Check

`scripts/e2e/cloud.ts` passes against a local dev server on a free port. A test at the layer where the cause is.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the ME walkthrough.
- 2026-11-20: dispatched on task/ME.11-fix-the-cloud-follow-up-message-for-the (v4 controller session).
- 2026-11-20: merged as 83ada8c7, review clean after 0 fix rounds. scripts/e2e/cloud.ts passes all nine steps. check, test and build passed on main.
