# HM.5 review: newsletter signup through our own backend

Two branches: harbourmaster `task/HM.5-newsletter-signup-through-our-backend` and agentum
`task/HM.5-newsletter-backend` (worktree `harbourmaster-wt/HM.5-agentum`, not merged by the dispatcher).

## Rounds

1. Round 1 at a21aa16c (harbourmaster) and 9e1a52c7 (agentum): must-fix. Removing the Name field
   left the 2-column form grid with a half-width email field and a Turnstile container in the
   second cell.
2. Round 2 on the fix commits 3b8e49b1 and 1b845792: clean.

## Browser steps skipped

The form was not opened in a browser, as the brief says. Still to check in the browser pass: the
form is one full-width column, the widget loads on localhost with Cloudflare's test key, and a
submit shows the sent message (needs `NEWSLETTERS_API_KEY` and `NEWSLETTERS_NEWSLETTER_ID` set
locally).

## Nits left

- The Turnstile container has no top margin and, for a managed widget, sits below the Subscribe
  button, which stays disabled until the check passes.
- After a widget error, a later automatic retry sets the token but the error message stays until
  the next submit.
- `import.meta.env.PROD` is true for every `vite build`, so staging builds also carry the
  production site key. Staging hostnames not on that widget fail the check, and the form shows the
  security-check message.
- Every upstream 422 shows "Please enter a valid email address." A broken newsletter config would
  read as a bad address to the visitor (the reference separates the two).
- With no `TURNSTILE_SECRET_KEY` a localhost request skips Turnstile, as in the reference. The task
  text says a missing secret refuses.
- agentum: `bun run check` fails on a typecheck error in
  `src/modules/messaging/attachment-rules.test.ts` that `main` already has. Its `bun.lock` was
  edited by hand to add only `@marsidev/react-turnstile`, because `bun add` rewrote unrelated
  entries.

## Beyond scope

- A rate limit on the route (the repo has `RateLimit` bindings).
- The optional Name field is gone from the form, because the API body takes only the email.

## Steps for Dom

- Confirm in the Cloudflare dashboard that widget `0x4AAAAAAGNxncr7sBoBDII8` is an Invisible or
  Managed type as intended (the form no longer forces a size).
- Set `NEWSLETTERS_API_KEY` and `NEWSLETTERS_NEWSLETTER_ID` as Worker secrets on `agentum-v2` and
  `agentum`. `TURNSTILE_SECRET_KEY` is already set on both.
- The production site key is committed in `newsletter-signup.tsx`, used by every `vite build`.
