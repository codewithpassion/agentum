# TM.13 browser verification

Verdict: pass. In a limited topic the lead's post lists only the mentioned member who is in the topic. In an open topic it lists both mentioned members. This held at 1280x800 and 390x844, with no console errors and no failed requests.

## Setup

- Dev server: `bunx wrangler d1 migrations apply DB --local && bunx vite dev --port 4350` in `apps/web`, on a fresh local database.
- Sign-in: `/login` showed "Welcome back, signed in as dev@..." from a saved browser session, so the "Dev login (local only)" link was not on the page. I opened `/api/dev-login` directly, which redirected through `/dev-login` to `/home`. That sign-in created the workspace.
- Agents: `bun scripts/dev/seed-fake-agent.ts` for `lead-ann` (Lead Ann), `writer-bo` (Writer Bo) and `checker-cy` (Checker Cy).
- Team "Desk wide", created from New team on `/teams`: all three agents plus Dev User, lead Lead Ann, "Lead listens" on, team rules `@writer-bo @checker-cy`. The fake runtime echoes its input, so every lead reply mentions both members. Screenshot `desktop-1.png`.
- `team-propose.ts` was not needed. The New topic dialog's "Only these members" boxes make a limited topic from the UI.

## Flows

Each post below names nobody, so the lead answers it.

| # | Size | Steps | What I saw | Screenshot |
|---|---|---|---|---|
| 1 | Desktop 1280x800 | Room, then New topic "Limited plan" with only Lead Ann and Writer Bo checked. Post "Please plan the launch". | Lead Ann's echo contains `@writer-bo @checker-cy`. Under it: **"Assigned to Writer Bo"**, with no Checker Cy. Only Writer Bo answered. Checker Cy posted nothing in the topic (posts: You, Lead Ann, Writer Bo). | `desktop-2.png` (dialog), `desktop-3.png` (result) |
| 2 | Desktop 1280x800 | New topic "Open plan" with no members checked. Post "Please plan the release". | **"Assigned to Writer Bo, Checker Cy"**. Writer Bo and Checker Cy both answered. | `desktop-4.png` |
| 3 | Phone 390x844 | Topics sheet, then New topic "Phone limited" with only Lead Ann and Writer Bo checked. Post "Please draft the notes". | **"Assigned to Writer Bo"**. Posts: You, Lead Ann, Writer Bo. No Checker Cy. | `phone-1.png` (sheet), `phone-2.png` (dialog), `phone-3.png` (result) |
| 4 | Phone 390x844 | Topics sheet, then New topic "Phone open" with no members checked. Post "Please review the notes". | **"Assigned to Writer Bo, Checker Cy"**. Both members answered. | `phone-4.png` (dialog), `phone-5.png` (result) |

Re-check: I reloaded all four topics fresh at both sizes. Each showed the same assigned line as above: limited topics "Writer Bo", open topics "Writer Bo, Checker Cy".

Harness slip: on the desktop open-topic post, my CLI call added " --name Message" to the message text. The post reads "Please plan the release --name Message". It has no bearing on the result.

## Console and network

- Console: only `[debug] [vite]` lines, the React DevTools info line and the Clerk development-keys warning. No errors and no page errors (`agent-browser errors` was empty). The dev server log, which mirrors the client console, held only the Clerk warning.
- Network: every tRPC call and post went through. On the fresh reloads of all four topics at both sizes (290 to 436 resources each), no resource returned 400 or above. The dev server logged no 500s or SQLITE errors.

## Unrelated observations

- The "Needs you" count rose with every flow (1 to 4). I did not look into it. It is probably the members' fake runs waiting on requests, and it is outside TM.13.
