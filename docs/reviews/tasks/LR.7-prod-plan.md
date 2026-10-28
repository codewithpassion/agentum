# LR.7 - production deploy plan

Prepared 2026-10-28 from main `48d32be9`. Nothing here was run against production, apart from read-only listings. Production Worker `harbourmaster`, host `harbourmaster.rockyshoreslabs.io`, D1 `harbourmaster`, R2 `harbourmaster-files`, Clerk production instance. Last production upload: 2026-10-27 01:29Z, version `d23c5cb9-d46e-4afd-84c2-cdbf66866209`.

## Go / no-go

**No-go (round 3, staging version `20f9e1e4-6468-4584-9c0b-584b39e77d98`, main `a26240e5`).** Fixed since round 2 and verified on staging: member exports (PDF and Word of a document, PPTX and PDF of a deck, files for Dom's Office check, which no longer blocks production), forced OAuth on a connector that answers without a 401 (reaches the Google redirect; Automatic and None unchanged), 40 px controls on the document page at 390 px, selection and addressed-comment triggers, Linux VM and managed runtimes with ask-before and approval continuation, member 15-minute renewal, no third-party browser requests for imported images, page discovery over more than one page, sandboxed embeds. Still failing: (1) document peer edits take 1.9 s for one character and about 6 s for a quick three, because the Durable Object awaits `authorize` (Clerk plus membership lookup) for every inbound frame inside its serial queue (`artifact-room.ts:1148`, `production-room.ts:64-84`, `:280`); the same queue makes eight simultaneous room admissions take up to 13 s (see `LR.7.md` round 3 for the fix). (2) Deck toolbar controls are 33 px at 390 px (`deck-editor.css:361`). Deck peer latency (2.3 s) is the known LR.12 follow-up and does not count. Needs Dom: Slack and machine runtimes, guest items (code mail, guest expiry, embeds, revocation, `LIVE_GUESTS_OFF`), and the Gmail OAuth login (needs a Google client). Go once failure (1) is fixed and re-measured on staging, or Dom decides to ship with the latency. Production also needs the `ARTIFACT_VIEW_KEY` secret (below).

## Pending D1 migrations on prod

`wrangler d1 migrations list DB --remote` (top-level config) reports ten pending (eleven with the new one): the ten below plus migration `0034_heavy_randall` (connector `auth_mode`, from LR.11, applied on staging in round 3): `0024_rare_jack_flag`, `0025_melodic_maximus`, `0026_real_maria_hill`, `0027_lyrical_shaman`, `0028_chemical_sinister_six`, `0029_fast_scarlet_spider`, `0030_nebulous_human_torch`, `0031_large_nightmare`, `0032_lovely_lake`, `0033_chief_magus`, `0034_heavy_randall`. Staging has applied all of them. Check `0024` to `0034` for table recreation and the `events` triggers (see CLAUDE.md) before running. Take a D1 backup first: `wrangler d1 export DB --remote --output tmp-prod-backup.sql`, or note the Time Travel bookmark with `wrangler d1 time-travel info DB`.

## Durable Object migrations

Tags in `wrangler.jsonc` run to `v9`: `v8` adds `ArtifactRoom` and `LiveArtifactMaintenance`, `v9` adds `GuestRun`. Production was last uploaded before these, so `wrangler deploy` applies the new tags. Tags are not per environment and are not reversible: a rollback does not delete the new classes. Confirm with `wrangler deployments status` afterwards.

## Secrets and bindings

Production secrets present: `ALLOWED_ORG_IDS`, `CF_EMAIL_ROUTING_TOKEN`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `RUN_TOKEN_KEY`, `SECRETS_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`.

Dom step, missing on production: **`ARTIFACT_VIEW_KEY`** (`openssl rand -base64 32 | wrangler secret put ARTIFACT_VIEW_KEY`). Without it the room ticket key is empty (`infra.ts:246`), share links and guest codes are off (`guest-infra.ts:63`). Optional: `GITHUB_TOKEN`. Not secrets, but check: `LIVE_GUESTS_OFF` unset keeps guests on (set it to a non-empty value to switch guests off).

Bindings in the top-level config that must exist on the account: D1 `DB`, R2 `FILES` (`harbourmaster-files`), `BROWSER`, `LOADER`, `EMAIL`, rate limits `EXPORT_LIMIT` (2012), `SHARE_OPEN_LIMIT` (2001), `SHARE_CALL_LIMIT` (2007), `APP_API_LIMIT` (2004), Durable Objects `MACHINE_RELAY`, `MANAGED_POLLER`, `PI_RUN`, `GUEST_RUN`, `LINUX_VM`, `SESSION_STREAM`, `MAILBOX`, `APP_STORE`, `ARTIFACT_ROOM`, `LIVE_ARTIFACT_MAINTENANCE`, queue consumer `harbourmaster-mail-events`, container `VmSession` (needs Docker on the deploy machine). Vars: `PUBLIC_BASE_URL` production host, `MAIL_DOMAIN=agents.rockyshoreslabs.io`, `MAIL_ZONE_ID`, `MAIL_WORKER_NAME`. The cron `* * * * *` runs on production only.

Clerk: production publishable key comes from `apps/web/.env.production.local` at build time. Guest and mention mail need Email Sending on `agents.rockyshoreslabs.io`.

## Deploy steps (Dom or an authorised session, from `apps/web`, PATH with node)

1. Merge the room latency fix (cache `authorize` in the Durable Object). Rerun the latency and admission checks on staging. Record the version id.
2. `bun run build` and confirm `dist/server/wrangler.json` names Worker `harbourmaster`, the production host, D1 `harbourmaster`, R2 `harbourmaster-files`. Grep `dist/client` for the dev Clerk key host: it must be absent.
3. Set `ARTIFACT_VIEW_KEY`.
4. `wrangler d1 migrations apply DB --remote` (the `deploy` script does not apply migrations).
5. `bun run deploy` (`bun run build && wrangler deploy`).
6. Smoke: `/api/health`, sign in as a real member, create a document through the app, open it in two browsers, export one PDF, check `wrangler tail` for 403 on `/api/rooms/`. If a Durable Object behaves like old code after a few minutes, redeploy once.

## Rollback

Code: `wrangler rollback <previous-version-id>` (previous: `d23c5cb9-d46e-4afd-84c2-cdbf66866209`). This does not undo D1 migrations or DO class migrations. The migrations add tables and columns; the old code ignores them, so rolling back code only is safe unless a migration recreated an existing table (check during step 1). For data loss use D1 Time Travel to the bookmark taken before step 4: `wrangler d1 time-travel restore DB --bookmark <id>`. Guests can be switched off without a deploy-wide rollback by setting `LIVE_GUESTS_OFF`.
