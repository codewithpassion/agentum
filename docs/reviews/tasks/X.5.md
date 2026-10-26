# X.5 review: Agent Task sign-in lands with an active organisation

## What changed

On the shared production Clerk instance, an Agent Task sign-in leaves the session `pending` with the `choose-organization` task, and the app treats a pending session as signed out. The cause is not an instance setting we can flip: `force_organization_selection` is true on both the dev and the production instance (read through the instance's public environment endpoint, nothing changed). The dev instance still activates an organisation by itself during an Agent Task sign-in, even for a user with two organisations, and the production instance does not, so the difference lies in Clerk, not in our settings.

The fix is in the app and works on both instances. `PendingSessionGate` (`apps/web/src/integrations/clerk/pending-session-gate.tsx`) is mounted in the Clerk provider. When the session is pending with the `choose-organization` task, it loads the user's memberships. A user with exactly one gets it activated (`soleOrganizationId`, unit tested), then the page you asked for reloads so the server sees the session. A user with several or none goes to `/choose-organization`. CLAUDE.md "Agent Task login" says so.

## Verdicts

Round 1 at 362a6ae: must-fix, three findings. The gate redirected to the picker while the membership list was still loading (a loading list reads as empty). It reloaded without checking the session had left `pending`, which loops in an unfocused tab where clerk-js `setActive` skips the server call. It read the reload target after `setActive` had moved the page to the task URL. Fixed in 5e009b6.

Round 2 at 5e009b6: clean.

## Not verified locally

The pending state cannot be reproduced on the dev instance, so the gate was run there only as a no-regression check: a fresh user with one organisation, and one with two, both sign in with the gate on and off and land active. The pending path rests on the installed Clerk sources and clerk-js 6.40.1. The staging sign-in check is the real test. The X.1 sign-in report was not on disk, so the cause description comes from the task file.

## Nits left

- The comment "the session is left for the picker" holds only because `setActive` navigates to the task URL through `taskUrls` in `provider.tsx`.
- After a still-pending result the gate does nothing until a reload.
- The `.catch` drops the error without logging it.
- On the success path the page may flash `/choose-organization` before the reload.
- The user can still land on "This organisation can't use Harbourmaster" if their only organisation is not in `ALLOWED_ORG_IDS`. The client can't see that list.

## Ideas beyond the scope

- Pick the only allowed organisation when a user has several, which needs the allowed list exposed to a pending session.

## Steps for Dom

None for the code. If the staging check still lands signed out, the Clerk dashboard has nothing to change from this task; tell the controller what `window.Clerk.session.currentTask` shows.
