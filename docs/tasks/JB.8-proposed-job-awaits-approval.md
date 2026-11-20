---
id: JB.8
title: "A proposed job reads as waiting for approval, not paused"
milestone: JB
size: S
status: in_progress
depends_on: []
branch: task/JB.8-proposed-job-awaits-approval
lane: services-jobs
executor: claude
---

From the JB gate review, round 1 (`docs/reviews/JB-1.md`).

Controller decision, 20 Nov 2026: this task may add the one `awaitingApproval` field to `JobSentence` in `packages/db/src/shared.ts`, a contract file, because no contract task is open for JB.

## Scope

- Add `awaitingApproval: boolean` to `JobSentence` in `@repo/db/shared` (contract-owned file, so the controller assigns this to the contract lane or allows it here), and set it in `jobs.ts` from `isPendingProposal(trigger)`.
- `job-row.tsx`: a job awaiting approval shows a "Waiting for approval" chip, not "Paused". It offers no Pause, Resume or Run now. It offers Approve and Reject, which call `routines.approve` / `routines.reject` or `triggers.approve` / `triggers.reject`. The web trigger's secret dialog still shows once on approve.
- Show the full routine prompt, or a way to open it, on a row awaiting approval, so the person sees what they approve.
- `desk/proposal-actions.tsx`: "See changes" goes to `/jobs` (or the agent's Jobs tab), not the redirecting `/routines` and `/triggers`.

## Check

- `jobs.test.ts`: a pending proposal reads `awaitingApproval: true, enabled: false`, and an approved paused routine reads `awaitingApproval: false, enabled: false`.
- `job-row.test.tsx`: a row awaiting approval renders Approve and Reject and no Resume or Run now. A paused row renders Resume.
- Browser: seed a run-proposed routine, open `/jobs`, see "Waiting for approval", approve it, and see the row turn into an enabled job with a next run.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the JB gate review, round 1.
- 2026-11-20: dispatched on task/JB.8-proposed-job-awaits-approval (v4 controller session).
