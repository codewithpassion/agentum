---
id: HM.5
title: "Newsletter signup through our own backend"
milestone: HM
size: M
status: done
depends_on: []
branch: null
lane: web-landing
executor: claude
---

Dom, 2026-11-23. The landing page form (`apps/web/src/modules/landing/newsletter-signup.tsx`) posts straight from the browser to `https://newsletters.rockyshoreslabs.io/api/public/newsletters/agentum/subscribe`. That public endpoint has no bot protection. Bot signups got the Plunk account locked, so the endpoint is now off in production and the form is broken.

Reference implementation: `/home/roboto/devel/harbouredge/harbouredgetraining/apps/web/src/modules/newsletter` (`server.ts`, `turnstile.ts`, `subscribe.ts` and their tests). Copy its shape; leave out its workflow and email parts, which this task does not need.

## Scope

1. Turnstile widget on the form (managed or invisible). The site key is public config. The form sends the token and a hidden `website` honeypot field.
2. A server route `POST /api/newsletter/subscribe` that, in this order:
   - validates the email and refuses a filled `website` field
   - verifies the Turnstile token with siteverify and fails closed: no `TURNSTILE_SECRET_KEY`, no token, or a failed check means refuse. Cloudflare's always-pass test secret is refused unless the request host is localhost.
   - only then calls `POST https://newsletters.rockyshoreslabs.io/api/v1/newsletters/<NEWSLETTERS_NEWSLETTER_ID>/subscribers` with `Authorization: Bearer <NEWSLETTERS_API_KEY>`, `Content-Type: application/json` and body `{"email": "...", "tags": []}`. No `skipConfirmation`, so the double opt-in email still goes out.
   - answers the form with a short success or error that the form shows. Upstream error text never reaches the browser.
3. `TURNSTILE_SECRET_KEY`, `NEWSLETTERS_API_KEY` and `NEWSLETTERS_NEWSLETTER_ID` are Worker secrets. Add them to the env types and `.env.example` with placeholder values. Local dev can use Cloudflare's test keys.
4. The form posts to the new route. No browser code calls `/api/public/newsletters` anywhere.
5. Both repos carry the same landing module, and both are live:
   - harbourmaster (this repo, Worker `agentum-v2`, agentumbot.io): the main work, on the task branch.
   - agentum, the old line (Worker `agentum`, agentum.rockyshoreslabs.io): `/home/roboto/devel/agentum`, branch `main` at 220741db. Port the same change there in a separate worktree, `git -C /home/roboto/devel/agentum worktree add /home/roboto/devel/harbourmaster-wt/HM.5-agentum -b task/HM.5-newsletter-backend main`. Run that repo's own check, tests and build there. Never touch the `/home/roboto/devel/agentum` checkout itself, and do not merge; the controller merges.

## Check

- Route tests in each repo: no token, bad token, missing secret, the test secret on a non-localhost host, and a filled honeypot are all refused before the newsletters API is called (assert the mocked fetch was not called). A valid token calls the API once with the right URL, header and body, without `skipConfirmation`.
- A test or grep check that no client code references `/api/public/newsletters`.
- `bun run check` and the changed packages' tests and build pass in each repo.

## Log
- 2026-11-23: added by controller from Dom's request.
- 2026-11-23: dispatched.
- 2026-11-23: merged at 62316721, review clean after 1 fix round. Also merged into the agentum repo's main (ba50e8d4). Turnstile widget and the three Worker secrets set on agentum-v2 and agentum by the controller. Deployed.
