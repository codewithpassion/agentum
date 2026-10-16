---
id: U.4
title: Keep Clerk sign-in flows inside the app
milestone: U
size: S
status: in_progress
depends_on: [U.3]
branch: task/U.4-clerk-redirects
---

Reported by Dom on 17 Oct 2026: signing in with Google on `/login` ends on a Clerk-hosted page, not back in the app.

## Scope

Find the cause before changing anything, and write it in the review file. Likely causes, in order:
1. Session tasks. Organizations are on, so a user with no active organisation gets a pending `choose-organization` task after sign-in. With no in-app task route, Clerk sends the user to its hosted Account Portal to finish it. `/dev-login` avoids this by setting the organisation explicitly.
2. The OAuth callback and the after-sign-in redirect. `<SignIn routing="hash" />` in `apps/web/src/routes/login.tsx` sets no `fallbackRedirectUrl` or `signUpUrl`, and the provider sets no `signInUrl`, `signUpUrl` or `afterSignOutUrl`, so Clerk may fall back to hosted pages.

Fix it so that every sign-in and sign-up path stays on the app's origin, including Google OAuth, email and password, sign-up, and a user who has no organisation or several. A pending organisation task is shown in the app, with Clerk's in-app task component or a route passed through the provider's `taskUrls`, and styled with the U.3 appearance. A signed-in user whose organisation isn't in `ALLOWED_ORG_IDS` sees an in-app message, not a loop or a Clerk page. The app's auth rules don't change.

## Check

Browser on a local dev server against the Clerk dev instance. Sign in with email and password as a throwaway test user that has no organisation, created and deleted again through the Clerk Backend API with the dev key from `.env.local`. Every URL along the way stays on the app's origin, and the organisation step shows in the app. Google OAuth can't be automated, so show from the code and Clerk's docs that the OAuth callback returns to the app. Dom checks it on staging after deploy. Dev login still lands on `/agents`. `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-17: added from Dom's report; waits for U.3 (same files).
