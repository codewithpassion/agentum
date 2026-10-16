# U.4 review notes

## Cause

Clerk builds its sign-in, sign-up and session-task URLs from the instance's hosted Account Portal (`faithful-falcon-1887.accounts.dev` on the dev instance) unless the provider sets them. Checked in the browser before the change: `Clerk.buildSignInUrl()` and `buildSignUpUrl()` both returned accounts.dev URLs. In Clerk's `clerk-js` 6.39.0, `buildTasksUrl` returns `taskUrls[key]` or else `buildSignInUrl() + #/tasks/<key>`, and the OAuth callback (`handleRedirectCallback`) calls `redirectToTasks` when the session has a pending task. So a Google sign-in by a user with no active organisation ended on the hosted page. Email and password stayed in the app, because `<SignIn routing="hash" />` handles the task itself inside the component, so only the OAuth callback and the sign-up transfer used the global URLs.

## Fix

The provider sets `signInUrl`, `signUpUrl`, the two fallback redirects, `afterSignOutUrl` and `taskUrls` for `choose-organization`. New routes: `/choose-organization` (`TaskChooseOrganization`, styled by the U.3 appearance) and `/sign-up`. On `/`, a signed-in user whose organisation is not allowed sees an in-app message with an organisation switcher and a sign-out button.

## Verification

Local dev server, Clerk dev instance, throwaway user with no organisation (created and deleted through the Backend API, together with the organisation it made). Email and password: `/login`, then `/choose-organization`, then the organisation form, then `/` with the in-app "can't use Harbourmaster" message. Every URL stayed on localhost. `/login` "Sign up" went to `/sign-up`. Sign-out landed on `/`. Dev login still landed on `/agents`. After the change `buildSignInUrl()` and `buildSignUpUrl()` return local URLs and the task redirect is `/choose-organization`. Google OAuth was not run (cannot be automated); the code path above shows the callback uses `taskUrls`. `bun run check && bun run test && bun run build` pass.

## Review rounds

Round 1 at 4a9d3f3: clean, six nits, no must-fix.

## Nits left

- `/` shows "Sign in" (not a redirect to `/choose-organization`) for a user with a pending task, because `<Show when="signed-in">` treats pending as signed out. Recovers through `/login`.
- The no-access message says "This organisation" also when the user has no active organisation (only reachable on `/` with a fully active session in practice).
- `/sign-up` is a bare `SignUp`, not wrapped in the `/login` card.

## Beyond scope

- The add-clerk skill template (`.claude/skills/add-clerk/templates/.../provider.tsx`) has no routing props or the two routes, so new projects would repeat this. Not updated here.

## Steps for Dom

- After deploy, sign in with Google on staging as a user with no active organisation. Expect `/choose-organization` on the staging origin, not an accounts.dev page.
- Also try Google with an email that has no account (restricted sign-up on) and expect to stay on the app origin.
