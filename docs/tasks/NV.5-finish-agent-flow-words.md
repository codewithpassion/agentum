---
id: NV.5
title: "Finish the runtime and task words in the agent flows"
milestone: NV
size: S
status: todo
depends_on: [RH.4, FR.4]
branch: null
lane: web-agent
executor: claude
---

From the NV gate review, round 1 (`docs/reviews/NV-1.md`, finding 1). The files sit in the `web-agent`, `web-builder` and `web-settings` lanes, plus one line in `components/map`. It waits for RH.4, which moves the profile files into tabs, and for FR.4, which is working in `components/agent/builder`. If RH.4 moved a file named below, change the file it moved to.

## Scope

- `components/agent/builder/dry-run-logic.ts`: say "Cloud" instead of "Cloudflare" in every note and blocker, using `RUNTIME_NAMES`.
- `components/agent/agent-form.tsx`: label the runtime field "Runs on". Replace "A session stops at $10 of spend" with conversation wording, and "one run" in the Turn limit text with "one task".
- `components/agent/profile/profile-logic.ts`: describe Anthropic cloud without "Managed Agents". Fix the capital in "Runs on My computer: <name>".
- `components/agent/profile/move-agent-logic.ts` and `move-agent-dialog.tsx`: no "runtime" in text people read. Fix "ran on Cloud before".
- `routes/_app/settings.model-providers.tsx`, `components/agent/profile/sheets/secrets/runtime-notes.tsx` and `components/map/map-logic.ts`: use Cloud, Anthropic cloud and My computer.
- Labels only. Stored values, routes, tRPC and server code stay as they are.

## Check

- This grep finds nothing outside tests and code comments: `grep -rnE "Cloudflare|Our machine|Managed Agents|[Mm]anaged agents|[Ss]ession stops|one run may|This runtime|new runtime|>Runtime<" apps/web/src/components apps/web/src/routes --include=*.ts --include=*.tsx`. On this commit it hits exactly the sites in finding 1, plus three code comments.
- `dry-run-logic.test.ts`, `agent-form.test.tsx`, `profile-logic.test.ts`, `move-agent-logic.test.ts` and `map-logic.test.ts` assert the new strings.
- Browser: Start blank, pick Cloud, and the dry run note says Cloud. Open Edit on a machine agent and read "Runs on".
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the NV gate review, round 1 (one must-fix).
