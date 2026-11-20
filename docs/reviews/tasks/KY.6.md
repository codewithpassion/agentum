# KY.6 review: your sign-ins for everyone

## Verdict

Round 1 (6c2db675, Opus medium): clean, nothing must-fix, eight nits. Clean after 0 fix rounds. I fixed the three stale page names the review found in the agent profile sheets (7ab34411). Browser proof: see `docs/reviews/tasks/KY.6/browser.md`.

## What was built

A page "Your sign-ins" at `/settings/sign-ins` lists `connectors.mine` for any member. An OAuth app gets a Connect or Sign in again link to the existing `/connect/<id>?as=user` flow. A header app gets Add sign-in or Replace, through the existing paste dialog. Disconnect calls `connectors.removeCredential`. A shared app (workspace secret or header template) and an app that needs no sign-in show a status and no action. The decision lives in `components/sign-ins/sign-in-logic.ts`, with tests.

The page is the first group ("You") of the settings nav and so appears in Find. It is also an item in the Clerk avatar menu, because the rail's Settings tab is admin-only. The nav and Find call `/settings/connectors` "Apps" and `/settings/secrets` "Passwords and keys", and the pages' headings match. Find's hint for each keeps the old name ("Connectors", "Secrets") so the old words still find them.

`connectors.mine` now also returns `headerName`, so the paste dialog names the right header. It is not a secret. The two service tests that pin the member fields were updated.

## Nits left

- The settings layout lists every nav item to a non-admin, including admin pages (`settings.tsx`). This predates KY.6.
- On desktop `/settings` redirects everyone to `/settings/model-providers`, an admin page (`settings.index.tsx`).
- Find has two entries called "Apps": the artifacts filter under "What agents use" and the connectors page under "Settings". The test that expected one was narrowed to the "What agents use" group.
- Old names remain in agent-facing messages: "Settings, Secrets" in `packages/services` (connectors.ts, secrets/placeholders.ts, connectors/secret.ts) and `apps/web/src/server/web-fetch/*`, with tests that pin them.
- `sign-in-logic.ts` declares its own credential status union. The page picks the badge colour by comparing the label "Signed in".
- The "Connected." notice from the URL and the "Disconnected from X." notice stay until the page reloads. Saving a pasted credential shows no confirmation.

## Ideas beyond scope

- Show the Settings tab to members when they can reach a page in it, or give members a "Your sign-ins" tab of their own in the rail footer.
- Hide admin-only pages from the settings nav for non-admins.

## Checks

`bun run check` and `bun run build` pass. `bun run test` passes except `apps/web` `guest-execution.test.ts`, which fails alone as well (known on this host, same on main). `live-artifacts/room.test.ts` passes alone. One run of the Rust test `result_closes_input_drains_output_and_waits_for_exit` failed under load and passed on the rerun.

## For Dom

Nothing needs your accounts. The browser proof used the Clerk dev instance only.
