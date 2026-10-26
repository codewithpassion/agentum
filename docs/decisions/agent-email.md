# Agent email, a module or a service-bound Worker

Task V5.2, a spike run in October 2026. Question: how does Harbourmaster reach Dom's agentic-inbox-hei (read at c6bd070) to give each agent an address, receive mail for it and send mail from it?

## Decision

Option A. Port the mailbox logic from agentic-inbox-hei into a portable module inside Harbourmaster's own Worker. Do not run the inbox as a second Worker behind a service binding.

Nothing in the port is a blocker. The port needs no change in agentic-inbox-hei, so the list of changes that Option B would force there is empty here and is kept at the end only for the reversal case.

Dom was asleep, so the choice is mine and Dom confirms it (see the next section). V5.1, V5.6 and V5.7 build on it.

One refinement differs. The task refinements say mail bodies and attachments can live in `FILES`. I put the raw MIME and the attachments there, and keep the parsed body in the mailbox Durable Object, capped at 1 MB, next to the rows that threading and listing query. A body in `FILES` alone would mean one R2 read per message for every thread view. Details are under "What gets ported".

## For Dom to confirm

1. Option A over Option B. If you want B, the reversal is cheap before V5.6 starts and expensive after. V5.3 and V5.5 do not change, because they only see `MailboxPort` and `EmailRoutingPort`. V5.1 loses `storeInbound` and `readAttachment` from the port and gets `createMailbox` back, because in B the inbox Worker stores the mail and calls Harbourmaster with the parsed message. V5.4's `receive` then takes that call instead of calling `storeInbound`. V5.6 becomes "add a `WorkerEntrypoint` to agentic-inbox-hei and a `MailboxPort` client over a service binding", and V5.7 swaps the `email()` handler for an RPC entrypoint (the list is at the end).
2. A per-mailbox Durable Object (`MailboxDO`, ported) over a Durable-Object-free variant. The variant keeps the index in D1 and the bodies in `FILES`. It removes one DO class, migration tag `v6` and the bun:sqlite adapter. It costs V5.1 two more columns (`message_id`, `references`) and moves threading into the service. I chose the DO because the threading and rate-limit code already ran on a real inbox (with two date bugs the port must fix, see "What gets ported"), and because V5.1 and V5.6 were written for it. Both fit behind the same `MailboxPort`, so you can change your mind later without touching V5.3 to V5.5.
3. The Cloudflare API token for Email Routing rules (Zone, Email Routing Rules, Edit, on `rockyshoreslabs.io`). Only you can make it. Name of the Worker secret, `CF_EMAIL_ROUTING_TOKEN`.
4. The production mail domain, and that Email Routing and Email Sending are on for it. Staging uses `rockyshoreslabs.io`, which needs nothing new.
5. Provisioning with one literal rule per address, not the catch-all. This leaves `ccau@` and `supatesta@` alone and caps one domain at about 198 agents (see "Provisioning path").
6. No `verifyDraft` (the Workers AI rewrite pass) in the port. Mail to an outside address waits for a person anyway, so the pass buys little.

## Why A

Option B keeps the inbox as it is and adds a `WorkerEntrypoint`, a service binding from Harbourmaster in three places (top level, `env.staging`, `env.staging.previews`) and a reverse binding for inbound mail. These facts decide against it.

- The inbox serves `mail.harbouredgeintelligence.com.au` behind Cloudflare Access. It would stay a separate deploy per environment, so staging needs its own inbox Worker, its own R2 bucket and Durable Objects, and a PR preview has no inbox Worker of its own to bind to, so previews would run with mail off or share staging's inbox.
- Every change to the mail path would land in a second repo that sits outside this task workflow, with its own deploy.
- The inbox keeps its mailbox registry as `mailboxes/<email>.json` objects in R2. Harbourmaster already has the registry in D1 (`agent_mailboxes`, V5.1), so B would keep two registries that must agree.
- The inbox pins zod 3.25.76 because Kumo forces it, and Harbourmaster is on zod 4. This is not a problem in A. `MailboxDO`, `tools.ts` and `email-helpers.ts` import no zod. Only `schemas.ts` does, and it holds types the port rewrites.
- Drizzle is 0.45.1 there and 0.44.7 here. The port uses only `drizzle-orm/sqlite-core` and `drizzle-orm/durable-sqlite`, and I checked that `durable-sqlite` exists in 0.44.7.
- The inbox has a vitest workers-pool suite in `workers/tests` and one workflow, `release-cli.yml`, for the CLI. Nothing tests `receiveEmail` or the threading queries. The suite cannot be reused here because Harbourmaster tests run under `bun test`. The port writes its own tests either way.

Option A costs these things.

- One more Durable Object class and migration tag. The next tag is `v6`, at the top level of `wrangler.jsonc` only.
- About 300 lines of ported Apache-2.0 code. The UI, Access auth, the AI agent, the MCP server, the API-key store and the REST routes do not come along.
- DO SQL does not run under `bun test`. The module takes a drizzle instance and a small `{ exec }` object, and the tests pass `bun:sqlite` versions, the way `packages/db` tests do.

## What gets ported

From `workers/durableObject/index.ts` and `migrations.ts`, with the Apache-2.0 header kept on each file.

- The schema (`folders`, `emails`, `attachments`) and the migration runner with its eight migrations, applied in the constructor.
- `createEmail`, `getEmail`, `getThreadEmails`, `updateEmail`, `moveEmail`, `deleteEmail`.
- `findThreadBySubject` and `checkSendRateLimit` (20 an hour and 100 a day per mailbox, counted from the `sent` folder). Keep the limit as a backstop for inside mail between agents, which skips approval. Fix the date comparisons when porting. The inbox stores `date` as an ISO string (`2026-10-26T12:34:56.000Z`) and compares it with `datetime('now', '-1 hour')` (`2026-10-26 11:34:56`). A `T` sorts after a space, so every row from the cutoff's own UTC day passes the hour test, and "20 an hour" really means 20 since midnight UTC. The 100-a-day test (`'-1 day'`) and `findThreadBySubject`'s 7-day window compare the same way, so each counts from the start of its cutoff day, and just after midnight that is the whole previous day. Compare with `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')` and its day and week equivalents, and test all three boundaries.
- A new `listThreads`, one grouped query on `COALESCE(thread_id, id)`. The inbox's six-CTE conversation query, the sort options, the folder CRUD, the search and the counts stay behind. The desk and the Mail tab list from D1, and an agent needs a plain recent-threads list.

From `workers/lib/email-helpers.ts` and `tools.ts`, the pieces `send` and `reply` need.

- `generateMessageId`, `buildReferencesChain`, `buildThreadingHeaders`, `textToHtml`, `escapeHtml`, `stripHtmlToText`.
- The send flow of `toolSendEmail` and `toolSendReply`, without `verify`, without `deferDelivery` and without `appendQuoted`.
- `validateSender` moves into the service. The sender must equal the mailbox's address, and the service reads the address from D1.

From `workers/index.ts` `receiveEmail`, the parsing steps and the threading rules (`In-Reply-To`, `References`, subject fallback). Not the R2 registry lookup, the `EMAIL_ADDRESSES` allow-list or the `EmailAgent` call.

Dropped. The Kumo and React Router UI, Access auth, `EmailAgent`, `EmailMCP`, `ApiKeyStore`, the REST routes, `verifyDraft`, `isPromptInjection` (V5.4 already quotes the body as untrusted content), the quoted-reply block (the agent reads the thread through `mail_read`) and folder CRUD.

Changes to the ported code, all small.

- The mailbox key is the `agent_mailboxes` row id, not the address. `idFromName(mailboxId)`. A row id survives an address change.
- Recipient comes from the envelope (`message.to`), not the first `To` header. A Bcc or a list copy has the right envelope recipient and a different header.
- `storeInbound` is idempotent. The inbox makes a new `crypto.randomUUID()` for every delivery, so a redelivered mail would start a second run. The dedupe key is the RFC `Message-ID`, or `sha256:<hex of the raw bytes>` when the mail has none. Look up an existing inbox row by that key (stored in `message_id`) first and return its ids.
- Body cap. Both D1 and DO SQLite refuse a value or row over 2 MB, and an inbound message can be 25 MiB. The body column holds at most 1 MB of UTF-8, cut at a character boundary with a marker. `raw_headers` keeps only `message-id`, `in-reply-to`, `references`, `from`, `to`, `cc`, `date`, `auto-submitted`, `list-id` and `precedence`, so it stays small.
- Inbound size cap. The Worker reads the whole message into memory before parsing, and PostalMime then holds decoded copies. I did not measure the peak. Set a constant `MAIL_MAX_INBOUND_BYTES` (in code, not a var) to 10 MiB and call `setReject("Message too large")` above it, until someone measures a 25 MiB message in a Worker.
- Thread resolution checks `References` and `In-Reply-To` against stored `message_id` values and falls back to the subject rule when none match (see "Findings for later tasks", item 2). A thread the agent starts gets its own RFC `Message-ID` as `thread_id`, not a bare uuid, so a later reply's `References[0]` can match it.
- Types are rewritten for zod-free use. The tool input schemas live in `packages/mcp` (V5.8), in zod 4.

Where it lives. A workspace package, `packages/mailbox/` (`@repo/mailbox`), with one `exports` subpath per module (`@repo/mailbox/store`, `/threading`, `/send`) and no barrel file, because HANDOVER and Biome's `noBarrelFile` override the global barrel rule. It has its own `package.json`, `tsconfig.json` and tests, and no imports from `apps/`. Ported code comes in with its tests, as HANDOVER requires, so the tests for each ported function are written new in `bun test`. The Durable Object class is a thin shell in `apps/web/src/server/mailbox.ts`, exported from `server.ts` and bound in V5.7, the way `SessionStream` wraps `session-stream-core.ts`.

## MailboxPort

V5.1 defines this in `packages/services/src/mail/types.ts`. Every method takes a `MailboxRef` first, `{ workspaceId, mailboxId }`, because the `FILES` keys carry the workspace.

```ts
interface MailboxPort {
  storeInbound(mailbox: MailboxRef, message: InboundMessage): Promise<StoredInbound>;
  listThreads(mailbox: MailboxRef, page: { limit: number; page: number }): Promise<ThreadSummary[]>;
  readThread(mailbox: MailboxRef, threadId: string): Promise<ThreadView | null>;
  readAttachment(mailbox: MailboxRef, messageId: string, attachmentId: string): Promise<StoredAttachmentBody | null>;
  send(mailbox: MailboxRef, draft: OutgoingDraft): Promise<SentMail>;
  reply(mailbox: MailboxRef, threadId: string, draft: OutgoingDraft): Promise<SentMail>;
  hold(mailbox: MailboxRef, draft: OutgoingDraft, threadId?: string): Promise<HeldMail>;
  release(mailbox: MailboxRef, messageId: string): Promise<SentMail>;
  discard(mailbox: MailboxRef, messageId: string): Promise<void>;
}
```

- `storeInbound` writes the message, its attachments and the raw MIME (see "Inbound path"). It returns `{ messageId, threadId, attachments, duplicate }`. The `FILES` puts happen first and the DO row last, so a row always has its bytes. If the DO insert fails after the puts, the retry writes a fresh set of keys and leaves harmless orphans. A duplicate returns the existing ids and `duplicate: true` and writes nothing. `mail.receive` still upserts the D1 rows and tries to start the run on a duplicate, because the DO write and the D1 write are separate and the first attempt may have died between them. The run's `requestId` (`mail:<externalMessageId>`) keeps that to one run, and `mail.received` is emitted only when the D1 message row is new.
- `send` and `reply` deliver at once and record the message in `sent`. `reply` builds `In-Reply-To` and `References` from the newest inbound message of the thread. Both throw a typed `MailError` with `code` `rate_limited`, `send_failed` or `bad_request`.
- `hold`, `release` and `discard` serve V5.5. A send that needs approval is stored as a draft (`hold`, which for a reply records the thread and its `In-Reply-To` target, while `release` builds the `References` chain at send time as `reply` does), delivered on Allow (`release`, which sends and moves the row to `sent`) or dropped on Deny or expiry (`discard`, which moves the row to `trash` and keeps the body). The outcome that `mail_read` shows comes from the D1 `mail_messages.status`, which the service merges into `readThread` by `external_message_id`.
- `OutgoingDraft` is `{ from, to[], cc[], subject, text, html? }`. The service sets `from` from the mailbox row, checks it, and decides inside or outside before it calls the port.

Shapes V5.1 needs to fix, in `packages/services/src/mail/types.ts`.

```ts
interface MailboxRef { workspaceId: string; mailboxId: string }
interface Address { address: string; name?: string }
interface InboundMessage {
  envelopeTo: string; envelopeFrom: string;
  from: Address; to: Address[]; cc: Address[];
  subject: string; text?: string; html?: string;
  messageId: string | null; inReplyTo: string | null; references: string[];
  headers: { autoSubmitted?: string; listId?: string; precedence?: string; contentType?: string; reportType?: string };
  attachments: { filename: string; mimetype: string; contentId?: string; disposition: string; content: Uint8Array }[];
  raw: Uint8Array;
}
interface AttachmentMeta { id: string; filename: string; mimetype: string; size: number; contentId?: string; disposition: string }
interface StoredAttachmentBody { filename: string; mimetype: string; size: number; body: ReadableStream<Uint8Array> }
interface StoredInbound { messageId: string; threadId: string; duplicate: boolean; attachments: AttachmentMeta[] }
interface SentMail { messageId: string; threadId: string; rfcMessageId: string }
interface HeldMail { messageId: string; threadId: string }
```

`ThreadSummary` has `threadId`, `subject`, `participants`, `messageCount`, `unreadCount` and `lastMessageAt`. `ThreadView` has `threadId` and its messages in date order, each with `messageId`, `folder`, `from`, `to`, `cc`, `subject`, `text`, `html`, `date` and `attachments`. The headers block gives V5.4 what its loop guard and bounce check read. A delivery status notification, or a bounce event, names the original RFC `Message-ID`, and D1 keys messages by our uuid. So V5.1 adds `rfc_message_id` to `mail_messages`, filled from `SentMail.rfcMessageId` on outbound rows.

Left off the list V5.1 gave. `createMailbox` has nothing to do, because a DO starts on first use and the registry is the D1 row. Provisioning is the row, the routing rule and the trigger row. `disable` is the same, a D1 status change and a rule deletion, and the history stays in the DO.

Ids. `mail_threads.external_thread_id` is the DO `emails.thread_id`. The order is a stored thread that the `References` or `In-Reply-To` ids match, else the subject-and-participants fallback (inside 7 days), else the first `References` entry or the `In-Reply-To` value, else the message's own uuid. The inbox runs the subject fallback only when a mail has no references at all. The port runs it whenever the ids match nothing. `mail_messages.external_message_id` is the DO `emails.id`, our uuid, never the RFC `Message-ID` header. That keeps V5.4's `requestId: "mail:<externalMessageId>"` stable, because `storeInbound` is idempotent. The RFC id stays inside the DO as `message_id`.

`EmailRoutingPort` has `findRule(address)`, `createRule(address)` and `deleteRule(ruleId)`.

## Inbound path

1. Cloudflare matches the recipient against a literal rule whose action is the Worker, and calls the `email(message, env, ctx)` export. `apps/web/src/server.ts` exports `{ fetch, scheduled, email }`.
2. The handler lowercases `message.to` and looks the address up in `agent_mailboxes` in D1, status `active`. No row means `message.setReject("Unknown address")`, which covers a rule left behind after a disable. A size above `MAIL_MAX_INBOUND_BYTES` is rejected the same way.
3. It reads the stream into a buffer (the inbox's `streamToArrayBuffer` size check carries over) and parses it with PostalMime (`^2.6.1` there, not yet installed here).
4. It builds an `InboundMessage`, raw bytes included, and calls `mail.receive` (V5.4). That calls `mailbox.storeInbound`, which assigns the message id and writes the raw MIME and attachments to `FILES`. Then `mail.receive` writes the `mail_threads` and `mail_messages` rows through `atomic`, emits `mail.received`, and starts the run when the mail trigger is on. Run start can go through `ctx.waitUntil` to keep the SMTP session short.
5. A thrown error decides whether the sender retries. The pages I read do not say, so V5.7 should test it on staging with a handler that throws.

Where the bytes live.

- Raw MIME, `FILES` at `<workspaceId>/mail/<mailboxId>/raw/<messageId>.eml`.
- Attachments, `FILES` at `<workspaceId>/mail/<mailboxId>/<messageId>/<attachmentId>/<filename>`, with the filename sanitized as the inbox does. V5.4 also copies them into the task folder.
- Parsed body (capped at 1 MB), headers subset and attachment metadata, the mailbox's DO SQLite.
- Index, snippet, status, approval link, D1.

## Provisioning path

One literal rule per agent address, action `worker`, created by `EmailRoutingPort.createRule` through the Cloudflare API. I did not find the request body in the docs search for this task, only Wrangler's `addresses` field. The endpoint I expect is `POST /zones/{zone_id}/email/routing/rules` with a `literal` matcher on `to` and a `worker` action naming the Worker, plus `GET` to list and `DELETE /rules/{id}`. V5.7 confirms the body against the API reference before it writes the fake-fetch test.

- `findRule(address)` lists the zone's rules (paged) and matches the literal `to` value. V5.3 calls it first and fails the mailbox row with "Address in use outside Harbourmaster" if a rule exists. Dom's `ccau@` and `supatesta@` are the two known cases.
- The action names a Worker, and the name differs per environment, `harbourmaster` in production and `harbourmaster-staging` on staging. A var supplies it, `MAIL_WORKER_NAME`.
- Zone and domain are vars too, `MAIL_ZONE_ID` and `MAIL_DOMAIN`. The token is the secret `CF_EMAIL_ROUTING_TOKEN`.
- Limit. Email Routing allows 200 rules per domain. With Dom's two on `rockyshoreslabs.io`, one domain holds about 198 agents. `createRule` must turn the limit error into a readable `failed` reason. Two ways out when it gets close. A subdomain gives a fresh 200 (a zone may hold 30 domains, and each needs Routing and Sending set up), or a catch-all on the apex pointing at the Worker with the address registry in D1 and `setReject` for unknown addresses. The catch-all is where I would go past roughly 150 agents, and it needs Dom's call because it changes how the domain treats unknown addresses.
- Why not the catch-all today. The task refinements say no, and I agree. Without it Cloudflare rejects an unknown address at SMTP time and no Worker runs.
- Why not Wrangler's top-level `addresses`. It is static config applied at deploy, applies to every environment, owns the rules it creates and removes managed rules that are no longer listed. Agent addresses appear at runtime from the app, so the app has to call the API itself.

## Sending

- A `send_email` binding named `EMAIL`. Keep `remote` off in `wrangler.jsonc` so local dev does not send real mail. The binding simulates locally, and a developer who wants a live send sets it in a local override.
- The `from` address must be on a domain onboarded for Email Sending. `rockyshoreslabs.io` is.
- Limits from the Email Service docs. 50 recipients across `to`, `cc` and `bcc`. 5 MiB per message with attachments. 20 allowlisted custom headers. 3,000 sends a month are included on Workers Paid, then $0.35 per 1,000. Sends to verified destination addresses cost nothing. Email Sending is in public beta.
- The port keeps the inbox's own 20 an hour and 100 a day per mailbox.
- Threading headers go in `headers` (`In-Reply-To`, `References`).

Wrangler changes, for V5.7.

- Durable Object binding `MAILBOX` to `MailboxDO` in all three places (top level, `env.staging`, `env.staging.previews`). Migration `{ "tag": "v6", "new_sqlite_classes": ["MailboxDO"] }` at the top level only.
- `send_email` `EMAIL`, `MAIL_DOMAIN`, `MAIL_ZONE_ID` and `MAIL_WORKER_NAME` in the same three places. Previews set `MAIL_DOMAIN` to `""`, which turns mail off there, and `MAIL_ZONE_ID` and `MAIL_WORKER_NAME` to `""` as well. A release that creates `MailboxDO` goes out with `wrangler deploy`, because Cloudflare refuses `versions upload` for a new DO class.
- `apps/web/.env.example` lists `CF_EMAIL_ROUTING_TOKEN`.
- No cron change. Production runs the minute tick, and staging does not, so `provisionPending` and approval expiry do not run on staging.

## Findings for later tasks

1. Bounces probably do not come back as mail to the agent. Email Sending onboarding adds an MX record on a `cf-bounce` subdomain so that bounces go to Cloudflare, not to the sender address. V5.4's rule "a delivery status notification marks the original outbound message `bounced`" may never fire for mail sent through the binding. Email Sending publishes `message.bounced`, `message.failed` and related events through Queues event subscriptions, scoped to one sending domain. A queue consumer is the likely real path. I have not tested it. V5.12 should send to a non-existent address on staging first and look at what arrives. If nothing arrives as mail, the controller decides whether V5.7 gains a Queue binding and a `queue()` handler, and V5.4 keeps the DSN parser only as a fallback.
2. The inbox stores its own generated `Message-ID` (`<uuid>@<domain>`) but does not pass it to `send()`. Whether Cloudflare accepts a `Message-ID` header, or what `result.messageId` is, I could not settle from the docs (the headers page lists platform-controlled headers I did not see in full). If the sent id differs from the stored one, a reply from Gmail carries a `References` entry the mailbox never stored. The inbox then starts a new thread, because it trusts `References[0]`. The thread breaks even when the ids do match, for a thread the agent started. The inbox stores `thread_id` as the bare uuid, and a reply's `References[0]` is the `<uuid@domain>` header, so the two never agree. V5.6 must check this against one real send, and the port resolves a thread by matching `References` and `In-Reply-To` against stored ids and then falling back to subject and participants. If `result.messageId` is the header value, store it as `message_id`.
3. `message.reply()` is not used. It allows one reply per inbound event and only to the sender, which does not fit an agent that answers after approval.
4. The staging check (V5.12) needs two Gmail legs that only Dom's account can do, unless the controller session has a Gmail connector.

## Changes in agentic-inbox-hei

For Option A, none. The port reads the repo and leaves it unchanged, so the inbox keeps working for Dom as it does today.

For the reversal to Option B, the list is as follows.

- A `WorkerEntrypoint` class with `createMailbox` (B needs it, because the registry there is R2 objects, which A does not), `listThreads`, `readThread`, `send`, `reply`, `hold`, `release` and `discard` over `MailboxDO` and `workers/lib/tools.ts`, exported from `workers/app.ts`.
- A reverse call into Harbourmaster on inbound mail, through a service binding to an RPC entrypoint on Harbourmaster's Worker, from `receiveEmail`.
- Mailbox creation without the Access-protected UI, and a registry that is not only R2 objects.
- A deploy of the inbox Worker per Harbourmaster environment, with its R2 bucket and DO namespaces, and an answer for previews.
- Tests and a deploy step in the inbox repo for all of it, since that repo has none for these paths today.

## What Dom sets up in Cloudflare

For staging (`rockyshoreslabs.io`, account `a12823016aa16d0a8dd2678b258bd751`). Email Routing and Email Sending are already on. The only thing missing is the API token.

1. Create an API token with Zone, Email Routing Rules, Edit on `rockyshoreslabs.io`. Wrangler cannot create tokens.
2. Give it to the controller, who runs `wrangler secret put CF_EMAIL_ROUTING_TOKEN --env staging`.
3. `MAIL_ZONE_ID` is a var, not a secret. The controller's login has `zone (read)`, so it can look the id up, or read it from the zone's Overview page.

For production, before its first deploy with mail on. Pick the mail domain. Turn on Email Routing and Email Sending for it, which adds the SPF, DKIM, DMARC and `cf-bounce` DNS records. Make a token for that zone (or one token covering both), set `CF_EMAIL_ROUTING_TOKEN` as a production secret, and set `MAIL_DOMAIN`, `MAIL_ZONE_ID` and `MAIL_WORKER_NAME` in `wrangler.jsonc`.

## Licence

agentic-inbox-hei is Apache-2.0 and Harbourmaster's root licence is MIT. They can live in one repo. Apache-2.0 asks for three things, and the port does them.

- Every ported file keeps its "Copyright (c) 2026 Cloudflare, Inc. / Licensed under the Apache 2.0 license" header, and a file that changes gets a line saying Harbourmaster modified it.
- `packages/mailbox/` carries a copy of the Apache-2.0 text as `LICENSE-APACHE-2.0` and a `NOTICE` naming the source repo and commit (c6bd070).
- The package's `package.json` sets `"license": "MIT AND Apache-2.0"`. Files Harbourmaster writes from scratch stay MIT.

## Method

I read the files the task names in agentic-inbox-hei at c6bd070, the V5.1 to V5.12 task files, `apps/web/wrangler.jsonc` and `apps/web/src/server.ts` here, and the Cloudflare Email Service docs for limits, the Email Workers handler, the sending binding and routing rules. I changed no Cloudflare state and ran no mail. The facts about the account, zone and rules come from the task refinements, not from a fresh read.
