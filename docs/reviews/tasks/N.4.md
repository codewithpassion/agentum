# N.4 review

Agent mail marked `bounced` or `failed` from Email Sending events.

## Verdict

Round 1 (99ab949): clean, eight nits, none applied. Clean after 0 fix rounds. `bun run check`, `bun run test` and `bun run build` pass, and the client bundle has no `drizzle`.

## What changed

Email Sending publishes `message.bounced`, `message.failed` and `message.rejected` (plus delivered, deferred and complained, which the handler ignores) to a queue through a Queues event subscription scoped to one sending domain. The payload names the mail by `payload.messageId`, the same id the send binding returns, which V5.12 stores in `mail_messages.rfc_message_id` without angle brackets.

- `apps/web/src/server.ts` has a `queue()` handler. `apps/web/src/server/mail-events.ts` holds its testable core: it maps the event type to a status, takes the reason from `bounce.reason`, `failure.reason`, `rejection.detail` or `delivery.smtpResponse`, acks events it ignores (other types, no message id, malformed body) and retries only the event whose write threw.
- `recordUndelivered` in `packages/services/src/mail/inbound.ts` (system principal only) finds outbound messages in status `sent` whose `rfc_message_id` matches in bare or bracketed form, then writes the new status, `last_error` and a `mail.bounced` or `mail.failed` event in one atomic write. A duplicate event finds no `sent` row and does nothing. Unknown ids do nothing. A `failed` event after a `bounced` one does not downgrade it.
- The DSN path (`bounce()`) stays as the fallback and now shares the write with the new path. It still sets no `last_error`.
- `message.rejected` (suppressed recipient, policy, spam) maps to `failed`, because the mail never left. A soft `message.bounced` (retries exhausted) maps to `bounced`; Cloudflare sends `message.deferred` while retries remain, and that is ignored.
- The agent sees it the same way as the DSN path: status in `mail_read` and the Mail tab, and the `mail.bounced` event. The `mail.failed` event from this path carries `error`, as the send path writes it.

## Wrangler

The consumer is in two of the three places. Production has queue `harbourmaster-mail-events`, `env.staging` has `harbourmaster-staging-mail-events`. `env.staging.previews` has no consumer: a queue takes one consumer, staging's Worker holds it, and mail is off in previews (empty `MAIL_DOMAIN`), so a preview has nothing to send or bounce. The binding rule in CLAUDE.md is about bindings the app reads; a consumer is not one.

## Steps for Dom or the controller

Make the queues before the deploy that carries this change. A Worker deployed with a consumer for a missing queue fails to deploy. The sending domain must already be onboarded in Email Sending (the zone `rockyshoreslabs.io`, id `4dd028fe52d70f89e51383e1689d601a`, for both).

Production (`agents.rockyshoreslabs.io`):

```bash
bunx wrangler queues create harbourmaster-mail-events
bunx wrangler queues subscription create harbourmaster-mail-events \
  --source email.sending \
  --zone-id 4dd028fe52d70f89e51383e1689d601a \
  --domain agents.rockyshoreslabs.io \
  --events message.bounced,message.failed,message.rejected \
  --name harbourmaster-mail-events
```

Staging (`rockyshoreslabs.io`):

```bash
bunx wrangler queues create harbourmaster-staging-mail-events
bunx wrangler queues subscription create harbourmaster-staging-mail-events \
  --source email.sending \
  --zone-id 4dd028fe52d70f89e51383e1689d601a \
  --domain rockyshoreslabs.io \
  --events message.bounced,message.failed,message.rejected \
  --name harbourmaster-staging-mail-events
```

The source name `email.sending` comes from the `--zone-id` help text of `wrangler queues subscription create`. If the CLI rejects it, make the subscription in the dashboard instead: Queues, the queue, Subscriptions, Subscribe to events, source Email Sending, the domain, and the three events. Then deploy staging, then production with Dom's go-ahead.

Staging check: send agent mail to a nonexistent address on a real external domain (not under `rockyshoreslabs.io`, which accepts and drops). The send call returns at once; the bounce arrives later. The message should turn `bounced` with the SMTP reason in `last_error`, and `mail.bounced` should appear in the agent's events.

Open question the staging check answers, the same one V5.12 left: whether `payload.messageId` equals the id the binding returned at send time. The docs call both the "unique email ID" and give the same shape (`0101018f...-msg-...`), so they should match. If the message stays `sent`, compare `mail_messages.rfc_message_id` with the event's `messageId` in the queue (`wrangler tail --env staging`, or read the queue from the dashboard) and tell the next task.

Optional: a dead letter queue for each events queue (`wrangler queues consumer add ... --dead-letter-queue`), so an event that fails three retries is kept. Not set up here.

## Nits left

- Two events for one mail delivered at the same instant could both pass the `sent` check and write two events. The row update is idempotent and queue batches run one at a time, so this is a theoretical race.
- Events are per recipient (`payload.recipient`) and the handler ignores it, so one bad recipient of a multi-recipient mail marks the whole mail, as the DSN path does. A `rejected` event for one recipient is then marked `failed` even if the others got the mail.
- The 500-character cap repeats `MAX_ERROR_LENGTH` from `outbound.ts`.
- The queue consumers set no `max_retries` or `dead_letter_queue`, so after three retries a failing event is dropped with only a log line.
- `type &&` in the guard in `mail-events.ts` is redundant.

## Ideas beyond the scope

- `message.complained` and `message.delivered` could set a `delivered` status or flag the recipient. Not asked for.
- The DSN path sets no `last_error`; it could keep the report's status text.
