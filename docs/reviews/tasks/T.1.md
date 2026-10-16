# T.1 review: Agent Task sign-in script

## Verdict per round

Round 1, commit 2540a6f: clean, no must-fix items. No fix rounds.

## Active organisation on an Agent Task session

The task asked whether an Agent Task session has an allowed organisation active. It does for the dev user. A local probe (Agent Task created for the `DEV_LOGIN_EMAIL` user, redirect to the local dev server) landed on `/agents`, which only happens when `me` succeeds, so the session had the Dev Workspace organisation active. The staging run did the same: the URL landed on `https://harbourmaster-staging.rockyshoreslabs.io/agents` with no sign-in screen or device code. The script sets nothing for this and no auth rule changed.

Caveat from the reviewer: `/api/dev-login` passes `org=` explicitly, so sign-in tokens may not activate an organisation on their own. The Agent Task session probably gets its organisation from Clerk's last-active-organisation behaviour for a user with one membership. Untested: `--email` for a user with no organisation or several, and any production user.

## Nits left

- `agent-login-helpers.ts:9-10`: the `biome-ignore` reason says "by spec", which the task file does not say. An interface would remove the suppression.
- `agent-login.ts` error output prints `error.message`. A Clerk API error might read better through `errors[0].longMessage`.

## Ideas beyond the scope

- Pass `sessionMaxDurationInSeconds` through a flag for long browser runs (default is 30 minutes).
- A `--open` flag that starts a browser session directly, so the URL never reaches a terminal.

## Steps for Dom

- Production: put the production Clerk secret key in `apps/web/.env.production.local` before using `--env production`. Not tried, since it needs the production instance.
- Preview: not run live. It needs an open PR preview, with the dev user's organisation in the preview's `ALLOWED_ORG_IDS`.
