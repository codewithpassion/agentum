# Agentum v2 cutover

Harbourmaster becomes Agentum v2. This runbook moves the Worker, its data and its hostnames to new names: staging first, then production in a maintenance window. Nothing in it has run yet. Every step that writes to Cloudflare, Clerk, DNS or GitHub is for Dom or a session Dom has cleared to deploy.

## What moves where

| | Old | New |
|---|---|---|
| Production Worker | `harbourmaster` | `agentum-v2` |
| Production hostname | `harbourmaster.rockyshoreslabs.io` | `agentumbot.io` (old one kept, see Redirects) |
| Staging Worker | `harbourmaster-staging` | `agentum-v2-staging` |
| Staging hostname | `harbourmaster-staging.rockyshoreslabs.io` | `staging.agentumbot.io` (old one kept) |
| D1 | `harbourmaster`, `harbourmaster-staging` | `agentum-v2`, `agentum-v2-staging` |
| R2 | `harbourmaster-files`, `harbourmaster-staging-files` | `agentum-v2-files`, `agentum-v2-staging-files` |
| Queues | `harbourmaster-mail-events`, `harbourmaster-staging-mail-events` | `agentum-v2-mail-events`, `agentum-v2-staging-mail-events` |
| `MAIL_WORKER_NAME` | the old Worker names | the new Worker names |
| Container app (VmSession) | `harbourmaster-vmsession`, `harbourmaster-vmsession-staging` | unchanged, pinned by `name` in `wrangler.jsonc` |
| Computer images | `ghcr.io/codewithpassion/harbourmaster-computer(-desktop)` | `ghcr.io/codewithpassion/agentum-computer(-desktop)` |

`MAIL_DOMAIN` stays `agents.rockyshoreslabs.io` (staging `rockyshoreslabs.io`). Mail addresses are zone state in rockyshoreslabs.io, not Worker state, and agent addresses people already write to would break if it changed. Moving mail to agentumbot.io is a separate project: Email Routing and Email Sending on that zone, and every mailbox address changes.

Agentum v1 (Worker `agentum`) keeps `agentum.rockyshoreslabs.io`, D1 `agentum` and R2 `agentum-attachments`. Only `agentumbot.io` leaves it.

## Decisions Dom makes before starting

1. **Clerk for agentumbot.io.** See "Clerk" below. Pick satellite domain or new production instance. The cutover cannot finish without one.
2. **Maintenance window length.** Production D1 is about 4 MB and R2 about 1.2 GB (3 Nov 2026), so 30 minutes is enough with the R2 pre-copy.

## Secret keys

Cloudflare never returns a secret's value, and the old `SECRETS_KEY` and `RUN_TOKEN_KEY` values are lost (the copies in `.env.local` do not match staging). Dom decided to rotate them: the new Worker gets new keys from `scripts/migrate-v2/keys.ts`. `ARTIFACT_VIEW_KEY` is known (`apps/web/.env.production.local`, `apps/web/.env.staging`), so it goes over unchanged and share links and live artifact guest sessions keep working.

Everything the copied database holds under the old `SECRETS_KEY` becomes unreadable, and everything signed with the old `RUN_TOKEN_KEY` stops verifying. `d1.ts --apply` scrubs the new database right after the import (`SCRUB_STEPS` in `scripts/migrate-v2/helpers.ts`): each value goes to the state the app already shows when a person removes or revokes it, so pages say "not set", "needs sign-in" or "revoked" instead of failing on a decrypt error. The dry run prints what the scrub would change. On staging data (3 Nov 2026) that was 9 workspace secrets, 2 connector credentials, 22 open managed sessions, 6 Anthropic keys, 2 model keys and 1 Slack app. "What people must redo after the cutover" below lists what people do afterwards.

No Durable Object stores a value encrypted with `SECRETS_KEY` or signed with `RUN_TOKEN_KEY`. `PiRun` keeps run and workspace ids and signs a new run token for each run. `ArtifactRoom` and the live artifact guest sessions use `ARTIFACT_VIEW_KEY`.

## How the Durable Objects move

A new Worker name starts with empty Durable Object namespaces. The old namespaces hold real state, so they move with the Worker:

| Class | What it stores | Alarms |
|---|---|---|
| `MailboxDO` | every agent mailbox's mail (SQLite) | none |
| `AppStore` | app artifacts' key-value storage (SQLite) | none |
| `ArtifactRoom` | live artifact documents, credentials, checkpoints (SQLite and KV) | yes, checkpoint timer |
| `PiRun` | each cloud session's run state, VM link, tools, skills | none |
| `VmSession` | the pointer to the VM's `/workspace/home` snapshot in R2 (`vm-snapshots/`), trust and prepare flags | idle check |
| `MachineRelay` | machine identity, computer hello, desktop lease, last seen | yes |
| `ManagedPoller` | one managed run's poll state | yes, until the run ends |
| `GuestRun` | a guest execution's phase and failures | yes, retry every 5 s |
| `LiveArtifactMaintenance` | `checkpointTick` | yes, re-arms itself every 2 s |
| `SessionStream` | nothing (open SSE streams in memory) | timer in memory |

All ten move, `SessionStream` too, so the old Worker keeps no namespace and the list stays uniform.

**Why not just add a v10 tag.** Wrangler sends every migration step to a Worker that does not exist yet. Kept in the array, v1..v9 would create all ten classes on `agentum-v2`, and a v10 `transferred_classes` would then aim at classes that already exist, which Cloudflare refuses ("Do not run a Create migration for the destination class before running a Transfer migration"). The shipped tags belong to `harbourmaster`'s history, not to the new Worker's.

**Why the committed config uses `exports`.** Wrangler decides which classes get SQLite locally (miniflare, the Vite plugin) from `new_sqlite_classes` or `exports`, and ignores `transferred_classes`. A transfer-only `migrations` array would run `MailboxDO`, `AppStore` and `ArtifactRoom` without SQL in `bun run dev`. So `apps/web/wrangler.jsonc` declares the classes with the declarative `exports` map, which Cloudflare treats as a no-op for namespaces that already exist on the Worker.

**The first deploy.** `scripts/migrate-v2/do-transfer.ts` patches the built `dist/server/wrangler.json`: it drops `exports` and adds one legacy migration, tag `v10`, with `transferred_classes` from `harbourmaster` (or `harbourmaster-staging`) to the same class name for all ten classes. That one deploy creates the Worker and takes the namespaces. Every later deploy uses the committed `exports` map. The script refuses to run when the target Worker already exists, because a Worker deployed without the transfer owns empty namespaces under the same names.

The legacy transfer needs one deploy and nothing from the old Worker. Cloudflare's newer `exports` transfer (`expecting-transfer` on the target, a `transferred` tombstone on the source) needs four deploys including two of the old Worker converted to `exports`, so it is not used.

**What happens to state.** The namespace keeps its id and changes owner. Stored data and scheduled alarms are part of each object's storage, so they move with it, and an alarm due during the deploy fires on the new Worker's class. Open WebSockets do not survive any deploy: daemons, computer clients and desktop viewers reconnect, and they reconnect to whatever hostname they hold (the old one is kept for that, see Redirects). After the transfer, bindings on the old Worker forward to the new class, so the old Worker would run against the new owner's objects if it still served traffic.

**VmSession and its container.** Each Durable Object namespace attaches to one container application, and wrangler names the app after the Worker (`agentum-v2-vmsession`). The config pins `name` to the existing `harbourmaster-vmsession` (staging `harbourmaster-vmsession-staging`) so the deploy updates the application already attached to the moved namespace instead of making a second one. Docs do not say what a transfer does to the attachment, so staging checks it. If it fails, VMs lose their home folders until fixed: the bytes sit in R2 under `vm-snapshots/`, and the pointer in `VmSession` storage. The deploying machine needs Docker either way.

**Checks after the first staging deploy, before anything else.** These answer what the docs leave open:

1. The deploy output lists the v10 migration with no error. `from` and `to` being the same name is allowed (only renames require different names), and this proves it.
2. `bunx wrangler containers list` shows `harbourmaster-vmsession-staging` with a new LAST MODIFIED and no `agentum-v2-vmsession-staging`. `bunx wrangler containers info <id>` names the VmSession namespace.
3. An agent mailbox shows its old mail. An app artifact shows its stored data. A live artifact opens with its content.
4. A Linux VM agent starts and its home folder has its old files.
5. A run that was running at the export does not finish: its run token or managed session was signed with the old `RUN_TOKEN_KEY`. Check it ends as `interrupted` once its lease has passed (the minute tick's reaper does this), and is not left `running`.

If any fails, stop and roll staging back before touching production.

**PR previews.** Each preview gets its own namespaces from the `exports` map, so previews never touch the staging namespaces. Previews branch off `agentum-v2-staging`, so none can deploy until the staging cutover is done. Run one test PR on the new repository after the staging cutover and check it gets fresh, empty Durable Objects.

## Redirects

The old hostnames stay attached to the new Worker as extra custom domains, listed in `LEGACY_HOSTS`. `src/server/legacy-host.ts` answers a browser page load there (GET or HEAD, `Accept: text/html`, no upgrade) with a 301 to the same path on `PUBLIC_BASE_URL`. Everything else is served in place:

- Installed daemons and computer clients hold the old URL. Their WebSocket upgrades follow no redirect.
- API callers, A2A peers and webhooks would lose the `Authorization` header (fetch drops it on a cross-origin redirect), and a 301 turns a POST into a GET.
- `curl | sh` installs without `-L` do not follow redirects.

`/mcp` keeps refusing the old host, because its DNS-rebinding guard accepts only `PUBLIC_BASE_URL`'s hostname. MCP clients must move (see External dependencies).

Clerk cookies still work on `harbourmaster.rockyshoreslabs.io`, a subdomain of the Clerk instance's primary domain.

Set `LEGACY_HOSTS` to `""` and drop the extra route once nothing calls the old hostnames.

## Clerk

Findings from 3 Nov 2026, read-only:

- v1 on `agentumbot.io` and `agentum.rockyshoreslabs.io` uses a Clerk **development** instance (`proven-jaguar-455.clerk.accounts.dev`). No v1 user identity carries over to v2 in any option.
- v2 production uses the production instance `ins_3LDH0LvG5SOMvxgdBIX2kyIj1Sf`, frontend API `clerk.rockyshoreslabs.io`. Its only domain is `rockyshoreslabs.io`, primary, no satellites. It is shared with another app, so its primary domain cannot change.
- v2 staging uses the development instance `faithful-falcon-1887.clerk.accounts.dev`. Development instances accept any origin, so `staging.agentumbot.io` needs no Clerk change.

A Clerk production instance serves one root domain. `agentumbot.io` is a different root domain, so one of these is needed:

**Option A: satellite domain on the existing instance.** Add `agentumbot.io` as a satellite (Dashboard, Domains, Satellites, or Backend API `POST /v1/domains` with `is_satellite: true`; it is a paid add-on). Add the CNAME `clerk.agentumbot.io` it asks for. Code changes: `isSatellite: true`, `domain: "agentumbot.io"` and `signInUrl` on the primary (an app on `rockyshoreslabs.io`) in `clerkMiddleware()` in `src/server.ts`, in `src/start.ts`, and on `<ClerkProvider>` in `src/routes/__root.tsx`. Sign-in happens on the primary domain and syncs back. Users, organisations and ids stay as they are. Costs: the add-on, a sign-in hop through `rockyshoreslabs.io`, and `routes/accept-invitation.tsx` and the `/login` page render `<SignUp>`/`<SignIn>` in place, which a satellite cannot do, so those flows need rework. Agent Task login on production needs checking on a satellite. The satellite flags are static options, but `harbourmaster.rockyshoreslabs.io` sits on the primary domain: with the flags set it would be treated as satellite traffic and lose its session. Either set them per request from the hostname, or make the legacy host redirect-only for pages that need a session.

**Option B: a new production instance with `agentumbot.io` as primary.** Clean first-party sign-in on agentumbot.io and no shared-instance coupling. Costs: new keys, the five Clerk DNS records on agentumbot.io, every user signs up again, organisations are recreated, and the D1 org and user ids are rewritten with `bun run migrate-clerk-ids` and a new mapping from `build-clerk-id-map` (the X.1 runbook, `docs/reviews/tasks/X.1.md`).

Either way, also: set `CLERK_*` secrets on the new Worker, add `https://agentumbot.io` wherever the instance lists allowed redirect origins, and turn on restricted sign-up and Organizations on a new instance.

## External dependencies

Things outside this repository that hold the old hostname or names:

| What | Where | Action |
|---|---|---|
| MCP connectors in Claude and other clients | each user's client, URL `https://harbourmaster.rockyshoreslabs.io/mcp` | re-add as `https://agentumbot.io/mcp`. The old URL fails the host check. Clerk OAuth clients themselves live on the Clerk instance and keep working with Option A. |
| Google OAuth client | Google Cloud console, client in `GOOGLE_OAUTH_CLIENT_ID` | add redirect URI `https://agentumbot.io/api/connectors/oauth/callback` (and `https://staging.agentumbot.io/...`). Keep the old one until no connect flow is in flight. |
| Connector OAuth clients from dynamic registration | stored per connector, registered with the old redirect URI | the scrub removes the ones with a client secret. The rest register again on the next connect, because their redirect URI no longer matches. |
| A2A peers | peers' configs, our agent cards | peers that fetched our card keep the old URL. It is served in place. Pushed webhook URLs stored at peers point at the old host, served in place too. Our own card now advertises agentumbot.io. |
| A2A extension URIs | `packages/a2a/src/extensions.ts` | unchanged on purpose. They are identifiers that peers compare, never fetched. |
| Slack app | api.slack.com app config: event, interactivity and slash-command request URLs, OAuth redirect URL | change to agentumbot.io. The old URLs keep working through the legacy host. |
| Installed daemons and computer clients | each machine's config | keep working on the old host. Re-enrol at leisure to move them. |
| Email Routing rules | zone rockyshoreslabs.io, one rule per mailbox, action `worker: harbourmaster` | `scripts/migrate-v2/email-rules.ts` repoints them. Rule names keep the `harbourmaster:` prefix, which `email-routing.ts` matches. |
| Email Sending events subscription | zone rockyshoreslabs.io, targets the queue by name | new subscription on the new queue (step below). |
| Claude Managed Agents environment | `ENVIRONMENT_NAME = "harbourmaster"` in `packages/services/src/managed/config.ts` | unchanged on purpose: existing environments are found by that name. |
| Release downloads | R2 keys `releases/<product>/...` | copied with R2. If the rename branch renames the product from `harbourmaster` to `agentum`, the new Worker serves `releases/agentum/...`: run `publish-releases` for each env (the deploy scripts do), and installed daemons that update from `releases/harbourmaster/latest.json` stop seeing updates unless that path keeps an alias. |
| Computer images | ghcr.io | the old `harbourmaster-computer(-desktop)` tags stay on ghcr.io, so pulled and pinned hosts keep working. Run the `computer images` workflow on the new repository before the production deploy, so new enrolment commands find `agentum-computer(-desktop)`. |
| GitHub Actions secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` for `preview.yml` | they stay with the old repository. Add them on `codewithpassion/agentum`. |
| Clerk | see Clerk | |
| v1's `wrangler.jsonc` | `/home/roboto/devel/agentum/apps/web/wrangler.jsonc` declares `agentumbot.io` | remove it there, or the next v1 deploy takes the domain back. |

## Before the window

From the new repository checkout, after `bun install`. Run wrangler through the repo (`bunx wrangler`, 4.151 or later; `exports` needs a recent one), from `apps/web`, which picks up `CLOUDFLARE_ACCOUNT_ID` from `.env.local`. The deploying machine needs Docker.

1. Make the resources (both environments; OC matches the old buckets):

   ```bash
   bunx wrangler d1 create agentum-v2-staging
   bunx wrangler d1 create agentum-v2
   bunx wrangler r2 bucket create agentum-v2-staging-files --location oc
   bunx wrangler r2 bucket create agentum-v2-files --location oc
   bunx wrangler queues create agentum-v2-staging-mail-events
   bunx wrangler queues create agentum-v2-mail-events
   ```

2. Put the two D1 ids into `apps/web/wrangler.jsonc` in place of `AGENTUM_V2_STAGING_D1_ID_PLACEHOLDER` and `AGENTUM_V2_D1_ID_PLACEHOLDER`, and commit. Previews keep their own placeholders.
3. Email Sending events: Cloudflare allows one subscription per domain, so the new queues are subscribed inside the window, in the "Repoint mail" step. Note the old subscription ids now: `bunx wrangler queues subscription list harbourmaster-staging-mail-events` and the same for `harbourmaster-mail-events`.
4. Apply the schema to the new databases: `bunx wrangler d1 migrations apply DB --remote --env staging` and `bunx wrangler d1 migrations apply DB --remote`.
5. Make an R2 API token with Object Read & Write on the four buckets (Dashboard, R2, Manage API tokens). Export `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.
6. Pre-copy R2: `bun scripts/migrate-v2/r2.ts --env production --apply` (and staging). It copies only missing or changed keys, so the run inside the window is short.
7. Secrets: `bun scripts/migrate-v2/secrets.ts --env production --apply` lists the old Worker's secret names (on 3 Nov 2026: `ARTIFACT_VIEW_KEY`, `CF_EMAIL_ROUTING_TOKEN`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `RUN_TOKEN_KEY`, `SECRETS_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`; staging the same minus the last) and writes `.wrangler/migrate-v2/agentum-v2.secrets.env` with empty values. Then `bun scripts/migrate-v2/keys.ts --env production --apply` writes new `SECRETS_KEY` and `RUN_TOKEN_KEY` values (32 random bytes each, standard base64) into that file. It prints neither key and refuses to replace a line that already has a value, so it is safe to run twice. Fill in the rest by hand, with `ARTIFACT_VIEW_KEY` exactly as before. Never commit the file, and delete it after the deploy. Do the same with `--env staging` for `agentum-v2-staging.secrets.env`.
8. Make the Clerk change for the chosen option (Option B: also the id rewrite inside the window, after the D1 copy).
9. Remove `agentumbot.io` from v1's `wrangler.jsonc` (in the agentum repository) so v1 deploys stop claiming it.
10. Dry runs, all read-only: `bun scripts/migrate-v2/d1.ts --env staging` (it also prints what the scrub would change), `bun scripts/migrate-v2/email-rules.ts --env staging` (with `CF_EMAIL_ROUTING_TOKEN` set), `bun run staging:build && bun scripts/migrate-v2/do-transfer.ts`, and `bunx wrangler deploy --dry-run -c dist/server/wrangler.json`.

## Staging cutover

1. Cut the old Worker's traffic: detach `harbourmaster-staging.rockyshoreslabs.io` from `harbourmaster-staging` in the dashboard (staging has no cron). This does not stop every write, see "What still writes" under Production.
2. Final R2 sync: `bun scripts/migrate-v2/r2.ts --env staging --apply`.
3. Copy D1, as late as possible: `bun scripts/migrate-v2/d1.ts --env staging --apply`, then go straight on to steps 4 and 5. It checks both databases applied the same migrations and the new one is empty, exports the old rows (`--no-schema`), drops the `d1_migrations` rows the new database already has, imports, compares row counts table by table, and then scrubs what only the old keys could read (see "Secret keys"). The scrub writes `.wrangler/migrate-v2/<database>-scrub.sql`, runs it, and fails if any step still counts a row. If it fails after the import, fix the cause and run that file with `bunx wrangler d1 execute <database> --remote --file <file>`: running `d1.ts` again refuses, because the new database is no longer empty. The schema comes from step 4 above, not from the dump: a full export creates tables in name order with each table's rows straight after, so `agents` rows arrive before the `workspaces` table exists and SQLite refuses them even with deferred foreign keys. The `events` triggers block only UPDATE and DELETE, so the INSERT-only import passes them.
4. Build and patch: `bun run staging:build && bun scripts/migrate-v2/do-transfer.ts --apply`.
5. Deploy that exact file, no rebuild in between:

   ```bash
   bun scripts/publish-releases.ts --env staging
   bunx wrangler deploy -c dist/server/wrangler.json --secrets-file .wrangler/migrate-v2/agentum-v2-staging.secrets.env
   ```

   Deploying from a terminal, wrangler asks to move `harbourmaster-staging.rockyshoreslabs.io` from the old Worker: answer yes. Without a terminal (CI, a piped shell) wrangler moves custom domains held by other Workers without asking.
6. Repoint mail: `bun scripts/migrate-v2/email-rules.ts --env staging --apply`. Then move the Email Sending subscription: `bunx wrangler queues subscription delete harbourmaster-staging-mail-events --id <old id>`, then create the new one:

   ```bash
   bunx wrangler queues subscription create agentum-v2-staging-mail-events \
     --source email.sending --zone-id 4dd028fe52d70f89e51383e1689d601a \
     --domain rockyshoreslabs.io \
     --events message.bounced,message.failed,message.rejected \
     --name agentum-v2-staging-mail-events
   ```

7. Run the Durable Object checks above, then smoke-check: sign in on `https://staging.agentumbot.io` with `bun run agent-login --env staging`; `/api/health`; open `/desk`; send mail to a staging agent address and see it arrive; open `https://harbourmaster-staging.rockyshoreslabs.io/desk` in a browser and land on `staging.agentumbot.io/desk`; a daemon enrolled on the old host reconnects.
8. Rebuild with the committed config and deploy again (`bun run staging:deploy`), so the Worker switches from the transfer migration to `exports`. The output should report no Durable Object changes.
9. Run a test PR on the new repository once its Actions secrets exist.

## Production cutover

Announce the window first. Tell people that runs still going when the window starts are lost and must be started again, and that some keys and connections need redoing afterwards (see "What people must redo after the cutover").

1. Run the `computer images` workflow on the new repository.
2. Cut the old Worker's traffic. Dashboard, `harbourmaster`, Settings: remove the cron trigger (the minute tick writes D1) and detach `harbourmaster.rockyshoreslabs.io`. Users see the domain down for the length of the window.

   **What still writes.** Detaching the domain does not stop the old Worker. Until the deploy in step 6 moves the Durable Objects: `ManagedPoller`, `GuestRun`, `LiveArtifactMaintenance` and `MachineRelay` alarms keep firing on the old Worker and write D1; hibernated daemon sockets stay open after the route goes and their heartbeats write `last_seen`; the old queue consumer drains mail events; inbound mail reaches `harbourmaster` until step 7. Rows those paths write between the D1 export and the deploy stay in the old database and are lost. Keep that gap to a minute or two: run step 4 immediately before steps 5 and 6.
3. Final R2 sync: `bun scripts/migrate-v2/r2.ts --env production --apply`.
4. Copy D1: `bun scripts/migrate-v2/d1.ts --env production --apply`. It scrubs after the import, as on staging. Option B: run the Clerk id rewrite on `agentum-v2` now.
5. Build and patch: `bun run build && bun scripts/migrate-v2/do-transfer.ts --apply`.
6. Deploy:

   ```bash
   bun scripts/publish-releases.ts --env production
   bunx wrangler deploy -c dist/server/wrangler.json --secrets-file .wrangler/migrate-v2/agentum-v2.secrets.env
   ```

   This takes `agentumbot.io` from v1's `agentum` Worker and `harbourmaster.rockyshoreslabs.io` from `harbourmaster` (wrangler asks in a terminal and does it silently without one). v1 keeps `agentum.rockyshoreslabs.io`. `www.agentumbot.io` has no record today; add one only if wanted.
7. Repoint mail: `bun scripts/migrate-v2/email-rules.ts --env production --apply`. Then move the Email Sending subscription: `bunx wrangler queues subscription delete harbourmaster-mail-events --id <old id>`, then create the new one:

   ```bash
   bunx wrangler queues subscription create agentum-v2-mail-events \
     --source email.sending --zone-id 4dd028fe52d70f89e51383e1689d601a \
     --domain agents.rockyshoreslabs.io \
     --events message.bounced,message.failed,message.rejected \
     --name agentum-v2-mail-events
   ```

8. Smoke-check as on staging, on `https://agentumbot.io`, with `bun run agent-login --env production --email <a user on the instance>`. Add: the minute tick runs (a scheduled trigger appears in `bunx wrangler tail agentum-v2`), a share link opened on the old host lands on agentumbot.io, an MCP client added at `https://agentumbot.io/mcp` lists tools.
9. Rebuild with the committed config and deploy again (`bun run deploy`).
10. Delete the filled secrets file. Update external dependencies from the table.

## What people must redo after the cutover

The rotated keys make these values unreadable. The scrub clears them, so the app shows each one as missing. Nothing reaches "Needs you" for them (`desk.railSources` covers requests, stuck runs and A2A approvals only), so tell each workspace's admins directly. The dry run's counts say which kinds a deployment has.

| What | Key | What breaks | State after the scrub | Who acts |
|---|---|---|---|---|
| Workspace secrets (`secrets.value_enc`) | `SECRETS_KEY` | an agent granted the secret fails each run that reads it | deleted, with their grants (`agent_secrets`) | a member re-creates each secret (name, mode, rules, hosts) and grants it to its agents again |
| Connector credentials, header and OAuth (`credentials.secret`) | `SECRETS_KEY` | connector calls fail to decrypt | `needs_auth`, the state an expired login has | each person, or the agent owner for agent credentials, reconnects the connector |
| Connector OAuth clients with a client secret, registered or typed in (`connectors.oauth` client) | `SECRETS_KEY` | the next sign-in fails at the token exchange | client removed | nobody for registered clients: the next connect registers again. For a typed-in client, an admin types the client id and secret again |
| The deployment's shared Google client on a connector | `SECRETS_KEY` | nothing | unchanged: it is sealed again on every connect | nobody |
| Anthropic keys for managed agents (`workspace_anthropic_keys`) | `SECRETS_KEY` | managed runs fail to decrypt the key | deleted, with the managed agents, skills and sessions made under them, as removing the key does | an admin enters the key again in workspace settings. Managed agents register again on their next run |
| Model provider keys (`workspace_model_keys`) | `SECRETS_KEY` | cloud runs on that provider fail | deleted ("not set") | an admin enters each key again |
| Slack apps (`slack_apps` bot token, signing secret, client secret) | `SECRETS_KEY` | Slack events fail the signature check, replies fail | `revoked`, as Revoke does | the agent owner pastes the bot token and signing secret again from api.slack.com, which brings the same app back |
| A2A connections we call out on (`a2a_connections.outbound_credential`) | `SECRETS_KEY` | our agent cannot call the peer | `revoked` (staging had none live) | the agent owner or an admin connects again. An Agentum peer is not told, so its side still shows the connection: its owner revokes it and pairs again |
| A2A push configs a peer set with a token (`a2a_push_configs`) | `SECRETS_KEY` | pushes to the peer fail | deleted | nobody: the peer polls the task, or sets a new push config |
| Queued A2A deliveries (`a2a_outbox`) | `SECRETS_KEY` | they could never be sent | deleted | nobody: they were notices to peers in flight |
| Push webhook tokens of our open outbound A2A tasks | `SECRETS_KEY` (derived) | a task approved after the cutover gives the peer a token whose hash does not match the stored one, so the peer's pushes for it are refused | unchanged | nobody: polling finishes the task |
| Share link URLs on the artifact Links list (`artifact_shares.token_encrypted`) | `SECRETS_KEY` | the owner could not copy an old link again | unchanged. The list shows the link without its token and no Copy button | nobody: old links still open, because opening checks the token's hash. To pass a link on again, make a new one |
| Waiting A2A pairing requests (`a2a_pairing_requests`) | `SECRETS_KEY` (derived) | a code shown before the cutover still works, but a client that asks again gets a new code that does not match the stored hash | unchanged | the owner types the first code, or the client asks again once the request has expired |
| Run tokens (`hm_run_`, `ag_run_`) of runs in flight, and outbound effect receipts waiting for approval | `RUN_TOKEN_KEY` | the run loses MCP, proxy, file and library access, and an approved effect cannot be used | the run ends `interrupted` when its lease passes, and shows under Needs you as stuck | the person who started it runs it again |
| Managed session tokens (`ag_ses_`) | `RUN_TOKEN_KEY` | the managed agent's MCP calls fail | sessions closed or deleted with the Anthropic key | nobody: the next run opens a new session |

## Rollback

Before the deploy in step 6 nothing has changed for users except the downtime: reattach the old domain, put the cron back.

After it, the namespaces belong to `agentum-v2`. To go back:

1. Move the custom domains back to `harbourmaster` in the dashboard (Workers, `harbourmaster`, Domains). Do not redeploy the old Worker from the pre-cutover commit: its config still creates classes whose namespaces now belong to `agentum-v2`, and whether Cloudflare refuses that upload or accepts it is untested. Put its cron back. Detach `agentumbot.io` from `agentum-v2` and, if v1 should have it again, redeploy v1 with it.
2. The old Worker's Durable Object bindings forward to the moved namespaces while `agentum-v2` exists, so do not delete `agentum-v2`. The old Worker then runs its own code against those objects. That is safe as long as the new code has not changed their storage format, which this cutover does not.
3. D1 writes made on `agentum-v2` stay in `agentum-v2`. The old database has everything up to the export, so the window's writes are lost unless copied back by hand. That is the reason for the window.
4. Point the Email Routing rules back: run `email-rules.ts` with the names swapped, or edit them in the dashboard.
5. To give the namespaces back for good, deploy `harbourmaster` once with a migration that transfers each class from `agentum-v2`, the mirror image of v10.

## If the new Worker exists

`do-transfer.ts` stops when `agentum-v2` or `agentum-v2-staging` already exists, for example after a stray `wrangler secret put` (which makes an empty Worker) or a deploy of the committed config. Check the account's Durable Object namespaces (Dashboard, Workers, Durable Objects). If the new Worker owns none, delete it with `bunx wrangler delete --name <worker>` and run the script again. If it owns empty namespaces, remove them with `deleted` tombstones in `exports` first, then transfer. If it already owns the moved namespaces, the transfer is done: skip to the D1, secrets and mail steps.

## After the cutover

- Keep the old Workers, databases and buckets for at least two weeks. Do not delete `harbourmaster` before checking the Durable Object namespaces list shows `agentum-v2` as the owner of all ten classes.
- Then delete the old D1 databases, buckets, queues and the old queue subscriptions, and remove the old container application only if `agentum-v2` no longer uses it (it is pinned to that name).
- Drop `LEGACY_HOSTS` and the old custom domains once logs show no traffic on them.
- A local `bun run dev` starts with an empty local database, because local D1 state is keyed by the database id, which changed.
