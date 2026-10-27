---
id: N.4
title: Mark agent mail bounced from Email Sending events
milestone: N
size: M
status: done
depends_on: []
branch: task/N.4-mail-bounces
lane: mail
executor: claude
---

Dom asked on 27 Oct 2026. Outbound agent mail uses the Email Sending binding, which sets the return path to `cf-bounce.<domain>`, so bounces go to Cloudflare and never reach the agent's mailbox. V5.4's rule "a delivery status notification marks the original outbound message `bounced`" therefore never fires (see `docs/decisions/agent-email.md`, risk 1, and `docs/reviews/tasks/V5.12.md`). Email Sending publishes `message.bounced`, `message.failed` and related events through Queues event subscriptions, scoped to one sending domain.

## Scope

- Check the current Cloudflare docs for Email Sending event subscriptions (event names, payload, how the message is identified) before writing code.
- A `queue()` consumer in the Worker that marks the matching outbound message `bounced` or `failed` with the reason, through the mail service, using the message id the binding reported at send time (V5.12 stores it; bounce matching accepts bracketed and bare ids). Unknown ids are acked and ignored.
- The agent sees the bounce the same way the DSN path would have shown it (status in `mail_read` and the Mail tab, plus whatever event the DSN path writes). Keep the DSN parser as the fallback.
- The queue binding in all three places in `wrangler.jsonc` (top level, `env.staging`, `env.staging.previews`), with separate queue names for production and staging. Previews may point at the staging queue or leave the consumer out; say which in the review file.
- Write the exact setup steps (queue create, event subscription for `agents.rockyshoreslabs.io` on production and `rockyshoreslabs.io` on staging) in the review file. The controller runs them. Don't create Cloudflare resources yourself.

## Check

- Unit tests: a bounced event marks the right message; a failed event too; an unknown id is ignored; a duplicate event is harmless.
- `bun run check && bun run test && bun run build` pass.
- On staging (controller): send agent mail to a nonexistent address on a real external domain and see the message turn `bounced`.

## Log
- 2026-10-27: added at Dom's request.
- 2026-10-27: dispatched.
- 2026-10-27: review clean after 0 fix rounds; merged. Queues and email.sending subscriptions created by the controller.
