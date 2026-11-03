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

1. **Clerk for agentumbot.io.** Decided on 3 Nov 2026: a new Clerk application, "Agentum", with its production instance on agentumbot.io. See "Clerk" below.
2. **Secret values.** Cloudflare never returns a secret's value. `SECRETS_KEY`, `RUN_TOKEN_KEY` and `ARTIFACT_VIEW_KEY` must go onto the new Worker with exactly the old values, or every encrypted connector credential, run token and share link in the copied database stops working. Find them before the window. Only `ARTIFACT_VIEW_KEY` is in `apps/web/.env.production.local` today.
3. **Maintenance window length.** Production D1 is about 4 MB and R2 about 1.2 GB (3 Nov 2026), so 30 minutes is enough with the R2 pre-copy.

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
5. A managed run started before the window finishes.

If any fails, stop and roll staging back before touching production.

**PR previews.** Each preview gets its own namespaces from the `exports` map, so previews never touch the staging namespaces. Previews branch off `agentum-v2-staging`, so none can deploy until the staging cutover is done. Run one test PR on the new repository after the staging cutover and check it gets fresh, empty Durable Objects.

## Redirects

The old hostnames stay attached to the new Worker as extra custom domains, listed in `LEGACY_HOSTS`. `src/server/legacy-host.ts` answers a browser page load there (GET or HEAD, `Accept: text/html`, no upgrade) with a 301 to the same path on `PUBLIC_BASE_URL`. Everything else is served in place:

- Installed daemons and computer clients hold the old URL. Their WebSocket upgrades follow no redirect.
- API callers, A2A peers and webhooks would lose the `Authorization` header (fetch drops it on a cross-origin redirect), and a 301 turns a POST into a GET.
- `curl | sh` installs without `-L` do not follow redirects.

`/mcp` keeps refusing the old host, because its DNS-rebinding guard accepts only `PUBLIC_BASE_URL`'s hostname. MCP clients must move (see External dependencies).

The new Clerk instance's root domain is `agentumbot.io`, so there is no Clerk session on `harbourmaster.rockyshoreslabs.io`. Page loads there redirect, so people sign in on agentumbot.io. A browser tab left open on the old host gets 401 from the API until it reloads.

Set `LEGACY_HOSTS` to `""` and drop the extra route once nothing calls the old hostnames.

## Clerk

Decision (Dom, 3 Nov 2026): production gets a new Clerk application, "Agentum", whose production instance runs on `agentumbot.io`. It replaces the shared production instance `ins_3LDH0LvG5SOMvxgdBIX2kyIj1Sf` (frontend API `clerk.rockyshoreslabs.io`, application "Harbourmaster", Clerk workspace `org_3EVqNw1dIDWPLHAsLSUYzRLon0y`). Another app also uses that instance, so never change its settings, users or organisations. The cutover only reads from it.

Staging, previews and local stay on the development instance `faithful-falcon-1887.clerk.accounts.dev`. Development instances accept any origin, so `staging.agentumbot.io` needs no Clerk change. v1 uses its own development instance (`proven-jaguar-455.clerk.accounts.dev`), and nothing from it carries over.

### The new instance

Not created yet (3 Nov 2026). The Clerk CLI on this machine is logged into another Clerk workspace, and the application must live in the workspace that holds "Harbourmaster" (`org_3EVqNw1dIDWPLHAsLSUYzRLon0y`). Once Dom has run `clerk auth login` into that workspace: `clerk apps create "Agentum" --json`, then `clerk deploy --domain agentumbot.io --yes` from a scratch directory (not this repository, so the CLI profile for it stays linked to Harbourmaster), then `clerk env pull --instance prod` and copy the three variables into `apps/web/.env.agentum-production.local` (mode 600). Fill in the application id, the production instance id, frontend API `https://clerk.agentumbot.io` and accounts portal `https://accounts.agentumbot.io` here.

### DNS on agentumbot.io

Clerk names five CNAME records once the production instance exists (`clerk api --instance prod /domains`, field `cname_targets`): `clerk.agentumbot.io` to `frontend-api.clerk.services`, `accounts.agentumbot.io` to `accounts.clerk.services`, and `clkmail`, `clk._domainkey` and `clk2._domainkey` to targets that are unique to the instance. All five are DNS only (not proxied), because Clerk terminates TLS. The apex record that serves v1 stays as it is. Dom adds them in the dashboard.

### Settings

Read from the old instance on 3 Nov 2026 (Backend API and its public `/v1/environment`), and set the same on the new one unless noted:

- Sign-in and sign-up: email address required, verified by email code, and usable to sign in with an email code. Password required at sign-up, minimum 15 characters, checked against known breaches (HIBP, also on sign-in). Google enabled. No phone, username, passkeys, MFA, SAML or enterprise SSO.
- Sign-up mode: the old instance is **public**, not restricted as CLAUDE.md suggested. The `workspaces` row is what admits an organisation, so public sign-up lets anyone make an account but not get in. Dom decides public or restricted for the new instance (restricted is free and still lets organisation invitations sign up).
- Allowlist, blocklist, disposable-domain and subaddress blocking: off (the allowlist and blocklist are paid features).
- Single session mode on (one signed-in account per browser).
- Organizations on: up to 20 members, creator gets `org:admin`, admins may delete, slugs off, organisation selection forced, the default roles `org:admin` and `org:member`, no organisation domains.
- Clerk Protect rules on.
- OAuth applications: dynamic client registration off, PKCE required. No OAuth applications, JWT templates, redirect URLs or allowed origins on the old instance, so none on the new one.
- Application name "Agentum" (the old one says "Harbourmaster"), home URL `https://agentumbot.io`.
- Session lifetime, inactivity timeout and the session token settings are not in the Backend API. Read them with `clerk config pull --app app_3Kk8QOcbXfKKWjg140Gw9SdYCBg --instance prod` once the CLI is in the right workspace, and copy the `session`, `session_settings`, `auth_*` and `organization_settings` keys onto the new instance with `clerk config patch --instance prod --file <patch> --dry-run`, then without `--dry-run`. Leave out branding and paths that name rockyshoreslabs.io.

### Keys

The new instance's keys are in `apps/web/.env.agentum-production.local` (gitignored by `.env.*.local`): `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` and `VITE_CLERK_PUBLISHABLE_KEY`. `bun run build` runs `vite build --mode agentum-production`, so Vite loads that file and the client bundle gets the new publishable key. `bun run agent-login --env production` and `bun run add-workspace --remote` read the secret key from the same file. `apps/web/.env.production.local` keeps the old instance's keys: `copy-clerk-users` and `build-clerk-id-map` read the old side from it, so don't overwrite it before the window is over.

The Worker gets the three values as secrets. Copy them from `.env.agentum-production.local` into `.wrangler/migrate-v2/agentum-v2.secrets.env` (step 7 under "Before the window"), never the old instance's values. The publishable and secret key must come from the same instance: the MCP OAuth metadata takes its issuer from the publishable key.

### For Dom, by hand

1. Add the five CNAME records in the table above to the agentumbot.io zone (Cloudflare account `a12823016aa16d0a8dd2678b258bd751`), each as DNS only (grey cloud), then wait for Clerk to show the domain, SSL and mail as verified (`clerk deploy status --wait`).
2. Google sign-in. A Clerk production instance needs its own Google OAuth credentials. In Google Cloud console, APIs & Services, Credentials, make an OAuth client of type Web application (or add these to the existing client `866818741519-5u4irvvmeaempeq3qoss6oivfcq9pd0j.apps.googleusercontent.com`, which the old instance uses for Google and One Tap):
   - Authorised JavaScript origins: `https://agentumbot.io` and `https://accounts.agentumbot.io`.
   - Authorised redirect URI: the one Clerk shows on that screen, expected to be `https://clerk.agentumbot.io/v1/oauth_callback`.
   - The OAuth consent screen must be published (In production), or only test users can sign in.
   Then paste the client id and secret into the Clerk dashboard (Agentum, Production, Configure, SSO connections, Google, Use custom credentials).
3. Clerk plan: the old instance runs on a plan without the allowlist. Nothing above needs a paid feature, but check the new application's plan in the dashboard if Clerk asks for one when the production instance is created.

### Users and organisations

The old instance has 4 users and 2 organisations (3 Nov 2026). Production D1 has a `workspaces` row for both organisations, and all 4 users are members, so everything on the instance belongs to Agentum:

| Organisation | Old id | Members |
|---|---|---|
| Harbour Edge Intelligence | `org_3LDLbiYGe7iohEccrRQuLeBqaX2` | dominik.fretz@harbouredgeintelligence.com (creator), dominik.fretz@gmail.com, dominik@harbouredge.ai, all `org:admin` |
| Dev Workspace | `org_3LDS2q9TcEW6F8xFpCihrMylLOz` | dev@rockyshoreslabs.io, `org:admin` |

No user has a password. One signs in with Google, the other three were made by scripts and have never signed in. So the move is a user import without passwords, through the Backend API, not invitations: `bun run copy-clerk-users` makes each user with their email address, already verified, and no password, then the organisations under their old names with the same members and roles. Each person then signs in on agentumbot.io with Google or an email code, and Clerk links a Google sign-in to the imported user by the verified email. Invitations would add an email round trip per person and a sign-up, and the organisations would still need making by hand. Clerk's dashboard import and its password digests are not needed with no passwords to carry.

Clerk ids can't be chosen, so the D1 ids are rewritten afterwards with the X.1 tools (`docs/reviews/tasks/X.1.md`). The old user id goes into each new user's `external_id` for reference.

Dry runs on 3 Nov 2026, read-only:

- `bun run copy-clerk-users --db <copy>` plans 4 users, 2 organisations and 2 extra memberships (the creator of each organisation is its first admin), with nothing on the new instance yet.
- `bun run migrate-clerk-ids --map <sample map> --db <copy>` and the same with `--d1 harbourmaster --remote` both report 196 cells in 164 rows of 20 tables, nothing unmapped, nothing ignored, exit 0. The copy was built from production D1 with SELECTs only. The sample map pointed the 6 old ids at placeholder ids, because the real new ids don't exist until `copy-clerk-users --apply` runs.
- `migrate-clerk-ids --d1` used to pass every SELECT in one `--command`, which the production schema now makes too long for the process argument limit (E2BIG). It now sends them in chunks.

In the window, after the D1 copy into `agentum-v2` (step 4 under "Production cutover"), from `apps/web`:

1. Export the new database to a SQLite file: `bunx wrangler d1 export agentum-v2 --remote --output ../../../tmp/agentum-v2.sql`, then load it as in X.1 step 2 into `../../../tmp/agentum-v2.sqlite`. Nothing serves `agentum-v2` yet, so the export blocks nobody.
2. Make the users and organisations: `bun run copy-clerk-users --db ../../../tmp/agentum-v2.sqlite`, read the plan, then the same with `--apply`. A second run reports everything as `EXISTS`.
3. Build the mapping: `bun run build-clerk-id-map --db ../../../tmp/agentum-v2.sqlite --out ../../../tmp/agentum-map.json --from .env.production.local --to .env.agentum-production.local`. It should write 2 organisations and 4 users and exit 0.
4. Dry runs: `bun run migrate-clerk-ids --map ../../../tmp/agentum-map.json --db ../../../tmp/agentum-v2.sqlite`, then `bun run migrate-clerk-ids --map ../../../tmp/agentum-map.json --d1 DB --remote`. Both must exit 0 with no `UNMAPPED` or `PROBLEM` lines, and about 196 cells.
5. Note a Time Travel bookmark: `bunx wrangler d1 time-travel info DB`.
6. Apply: `bun run migrate-clerk-ids --map ../../../tmp/agentum-map.json --d1 DB --remote --apply`. The same command without `--apply` must then report 0 cells.

`DB` is `agentum-v2` in the committed `wrangler.jsonc`. Rollback for the ids: the same command with `--apply --invert`, or `bunx wrangler d1 time-travel restore DB --bookmark <bookmark>`. The old database and the old instance are never written, so going back to `harbourmaster` needs nothing from Clerk.

After the cutover every user signs in again on agentumbot.io, and every MCP OAuth client approved against the old instance has to be connected and approved again: client ids belong to an instance.

## External dependencies

Things outside this repository that hold the old hostname or names:

| What | Where | Action |
|---|---|---|
| MCP connectors in Claude and other clients | each user's client, URL `https://harbourmaster.rockyshoreslabs.io/mcp` | re-add as `https://agentumbot.io/mcp`. The old URL fails the host check. OAuth clients approved against the old Clerk instance don't carry over: reconnect the client, then a member approves it again. |
| Google OAuth client | Google Cloud console, client in `GOOGLE_OAUTH_CLIENT_ID` | add redirect URI `https://agentumbot.io/api/connectors/oauth/callback` (and `https://staging.agentumbot.io/...`). Keep the old one until no connect flow is in flight. |
| Connector OAuth clients from dynamic registration | stored per connector, registered with the old redirect URI | connectors that registered dynamically need reconnecting if the provider checks the redirect URI. Find them in `connectors` rows after the move. |
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
| Clerk | see Clerk. The old shared instance keeps `rockyshoreslabs.io` and is never changed. | |
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
3. Subscribe the new queues to Email Sending events:

   ```bash
   bunx wrangler queues subscription create agentum-v2-staging-mail-events \
     --source email.sending --zone-id 4dd028fe52d70f89e51383e1689d601a \
     --domain rockyshoreslabs.io \
     --events message.bounced,message.failed,message.rejected \
     --name agentum-v2-staging-mail-events
   bunx wrangler queues subscription create agentum-v2-mail-events \
     --source email.sending --zone-id 4dd028fe52d70f89e51383e1689d601a \
     --domain agents.rockyshoreslabs.io \
     --events message.bounced,message.failed,message.rejected \
     --name agentum-v2-mail-events
   ```

4. Apply the schema to the new databases: `bunx wrangler d1 migrations apply DB --remote --env staging` and `bunx wrangler d1 migrations apply DB --remote`.
5. Make an R2 API token with Object Read & Write on the four buckets (Dashboard, R2, Manage API tokens). Export `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.
6. Pre-copy R2: `bun scripts/migrate-v2/r2.ts --env production --apply` (and staging). It copies only missing or changed keys, so the run inside the window is short.
7. Secrets: `bun scripts/migrate-v2/secrets.ts --env production --apply` lists the old Worker's secret names (on 3 Nov 2026: `ARTIFACT_VIEW_KEY`, `CF_EMAIL_ROUTING_TOKEN`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `RUN_TOKEN_KEY`, `SECRETS_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`; staging the same minus the last) and writes `.wrangler/migrate-v2/agentum-v2.secrets.env` with empty values. Fill it in. Never commit it, and delete it after the deploy.
8. Clerk: the Agentum instance exists, its DNS is verified and its keys are in `apps/web/.env.agentum-production.local` (see "Clerk"). Dom has done the steps under "For Dom, by hand". Put the three `CLERK_*` values from that file into the secrets file from step 7. Run `bun run copy-clerk-users --db <a SQLite copy of production D1>` to see the plan. Users, organisations and the id rewrite happen inside the window.
9. Remove `agentumbot.io` from v1's `wrangler.jsonc` (in the agentum repository) so v1 deploys stop claiming it.
10. Dry runs, all read-only: `bun scripts/migrate-v2/d1.ts --env staging`, `bun scripts/migrate-v2/email-rules.ts --env staging` (with `CF_EMAIL_ROUTING_TOKEN` set), `bun run staging:build && bun scripts/migrate-v2/do-transfer.ts`, and `bunx wrangler deploy --dry-run -c dist/server/wrangler.json`.

## Staging cutover

1. Cut the old Worker's traffic: detach `harbourmaster-staging.rockyshoreslabs.io` from `harbourmaster-staging` in the dashboard (staging has no cron). This does not stop every write, see "What still writes" under Production.
2. Final R2 sync: `bun scripts/migrate-v2/r2.ts --env staging --apply`.
3. Copy D1, as late as possible: `bun scripts/migrate-v2/d1.ts --env staging --apply`, then go straight on to steps 4 and 5. It checks both databases applied the same migrations and the new one is empty, exports the old rows (`--no-schema`), drops the `d1_migrations` rows the new database already has, imports, and compares row counts table by table. The schema comes from step 4 above, not from the dump: a full export creates tables in name order with each table's rows straight after, so `agents` rows arrive before the `workspaces` table exists and SQLite refuses them even with deferred foreign keys. The `events` triggers block only UPDATE and DELETE, so the INSERT-only import passes them.
4. Build and patch: `bun run staging:build && bun scripts/migrate-v2/do-transfer.ts --apply`.
5. Deploy that exact file, no rebuild in between:

   ```bash
   bun scripts/publish-releases.ts --env staging
   bunx wrangler deploy -c dist/server/wrangler.json --secrets-file .wrangler/migrate-v2/agentum-v2-staging.secrets.env
   ```

   Deploying from a terminal, wrangler asks to move `harbourmaster-staging.rockyshoreslabs.io` from the old Worker: answer yes. Without a terminal (CI, a piped shell) wrangler moves custom domains held by other Workers without asking.
6. Repoint mail: `bun scripts/migrate-v2/email-rules.ts --env staging --apply`.
7. Run the Durable Object checks above, then smoke-check: sign in on `https://staging.agentumbot.io` with `bun run agent-login --env staging`; `/api/health`; open `/desk`; send mail to a staging agent address and see it arrive; open `https://harbourmaster-staging.rockyshoreslabs.io/desk` in a browser and land on `staging.agentumbot.io/desk`; a daemon enrolled on the old host reconnects.
8. Rebuild with the committed config and deploy again (`bun run staging:deploy`), so the Worker switches from the transfer migration to `exports`. The output should report no Durable Object changes.
9. Run a test PR on the new repository once its Actions secrets exist.

## Production cutover

Announce the window first.

1. Run the `computer images` workflow on the new repository.
2. Cut the old Worker's traffic. Dashboard, `harbourmaster`, Settings: remove the cron trigger (the minute tick writes D1) and detach `harbourmaster.rockyshoreslabs.io`. Users see the domain down for the length of the window.

   **What still writes.** Detaching the domain does not stop the old Worker. Until the deploy in step 6 moves the Durable Objects: `ManagedPoller`, `GuestRun`, `LiveArtifactMaintenance` and `MachineRelay` alarms keep firing on the old Worker and write D1; hibernated daemon sockets stay open after the route goes and their heartbeats write `last_seen`; the old queue consumer drains mail events; inbound mail reaches `harbourmaster` until step 7. Rows those paths write between the D1 export and the deploy stay in the old database and are lost. Keep that gap to a minute or two: run step 4 immediately before steps 5 and 6.
3. Final R2 sync: `bun scripts/migrate-v2/r2.ts --env production --apply`.
4. Copy D1: `bun scripts/migrate-v2/d1.ts --env production --apply`. Then run the Clerk steps 1 to 6 under "Clerk", "Users and organisations": export `agentum-v2`, `copy-clerk-users --apply`, `build-clerk-id-map`, the dry runs, the bookmark, and `migrate-clerk-ids --apply` on `agentum-v2`.
5. Build and patch: `bun run build && bun scripts/migrate-v2/do-transfer.ts --apply`.
6. Deploy:

   ```bash
   bun scripts/publish-releases.ts --env production
   bunx wrangler deploy -c dist/server/wrangler.json --secrets-file .wrangler/migrate-v2/agentum-v2.secrets.env
   ```

   This takes `agentumbot.io` from v1's `agentum` Worker and `harbourmaster.rockyshoreslabs.io` from `harbourmaster` (wrangler asks in a terminal and does it silently without one). v1 keeps `agentum.rockyshoreslabs.io`. `www.agentumbot.io` has no record today; add one only if wanted.
7. Repoint mail: `bun scripts/migrate-v2/email-rules.ts --env production --apply`.
8. Smoke-check as on staging, on `https://agentumbot.io`, with `bun run agent-login --env production --email dominik.fretz@harbouredgeintelligence.com` (any user `copy-clerk-users` made works). Sign in once with Google too. Add: the minute tick runs (a scheduled trigger appears in `bunx wrangler tail agentum-v2`), a share link opened on the old host lands on agentumbot.io, an MCP client added at `https://agentumbot.io/mcp` lists tools.
9. Rebuild with the committed config and deploy again (`bun run deploy`).
10. Delete the filled secrets file. Update external dependencies from the table.

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
- Once production runs on the Agentum instance, delete `apps/web/.env.production.local`, which holds the old instance's keys only for `copy-clerk-users` and `build-clerk-id-map`.
