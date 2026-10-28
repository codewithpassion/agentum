# LR.7 - production deploy plan

Prepared 2026-10-28 from main `48d32be9`. Nothing here was run against production, apart from read-only listings. Production Worker `harbourmaster`, host `harbourmaster.rockyshoreslabs.io`, D1 `harbourmaster`, R2 `harbourmaster-files`, Clerk production instance. Last production upload: 2026-10-27 01:29Z, version `d23c5cb9-d46e-4afd-84c2-cdbf66866209`.

## Go / no-go

**No-go (round 4, staging version `435d66e4-b003-4e0e-ba7a-f1dad77ea28c`, main `0fd6ef2b`).** Fixed since round 3 and verified on staging: document peer latency (1 char median 487 ms, max 694 ms; 3 chars all arrived median 383 ms, max 702 ms), deck peer latency (1 char median 468 ms, max 1352 ms; 3 chars median 457 ms, max 966 ms), same-cell concurrent typing in a deck table (5 of 5, both sides converge), document controls at 390 px (0 of 69 under 40 px), role downgrade (socket closes on the call, reconnect shows viewer, writes blocked), exports (docx, pdf, pptx, deck pdf all 200), forced OAuth with no client (shared Google client unset, manual client dialog opens). Still failing: (1) room admission: one socket alone takes 2.2 s to its first frame, eight at once take up to 13.3 s (limit 3 s). The route and the Durable Object each run the full Clerk member check (`auth.ts:98`, `:105`, `:39`; `routes.ts:46`, `production-room.ts:396`), about 0.7 s each. (2) Deck controls at 390 px: 24 of 56 are 33 to 35 px (`deck-editor.css:361` only covers `.ld-toolbar`; Present, All slides, Version history, Move slide, Comment/Ask, and the inspector fields sit outside it). (3) Revocation (Clerk membership removal) closes the room 1.2 to 1.9 s after the API returns (limit 1 s); the 2 s poll at `artifact-room.ts:1040` sets that bound. Needs Dom: Slack and machine runtimes, guest items (code mail, guest expiry, embeds, revocation, `LIVE_GUESTS_OFF`), Gmail OAuth login (needs a Google client; `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` are optional prod secrets from LR.13, unset means the manual client dialog). Go once failures 1 and 2 are fixed and re-measured, or Dom accepts them (failure 3 is a bound of the current design and could be accepted). Pending prod D1 migrations are `0024` to `0034`. Production also needs the `ARTIFACT_VIEW_KEY` secret (below).

## Pending D1 migrations on prod

`wrangler d1 migrations list DB --remote` (top-level config) reports ten pending (eleven with the new one): the ten below plus migration `0034_heavy_randall` (connector `auth_mode`, from LR.11, applied on staging in round 3): `0024_rare_jack_flag`, `0025_melodic_maximus`, `0026_real_maria_hill`, `0027_lyrical_shaman`, `0028_chemical_sinister_six`, `0029_fast_scarlet_spider`, `0030_nebulous_human_torch`, `0031_large_nightmare`, `0032_lovely_lake`, `0033_chief_magus`, `0034_heavy_randall`. Staging has applied all of them. Check `0024` to `0034` for table recreation and the `events` triggers (see CLAUDE.md) before running. Take a D1 backup first: `wrangler d1 export DB --remote --output tmp-prod-backup.sql`, or note the Time Travel bookmark with `wrangler d1 time-travel info DB`.

## Durable Object migrations

Tags in `wrangler.jsonc` run to `v9`: `v8` adds `ArtifactRoom` and `LiveArtifactMaintenance`, `v9` adds `GuestRun`. Production was last uploaded before these, so `wrangler deploy` applies the new tags. Tags are not per environment and are not reversible: a rollback does not delete the new classes. Confirm with `wrangler deployments status` afterwards.

## Secrets and bindings

Production secrets present: `ALLOWED_ORG_IDS`, `CF_EMAIL_ROUTING_TOKEN`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `RUN_TOKEN_KEY`, `SECRETS_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`.

Dom step, missing on production: **`ARTIFACT_VIEW_KEY`** (`openssl rand -base64 32 | wrangler secret put ARTIFACT_VIEW_KEY`). Without it the room ticket key is empty (`infra.ts:246`), share links and guest codes are off (`guest-infra.ts:63`). Optional: `GITHUB_TOKEN`, `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (shared Google client for connectors; when unset a forced-OAuth connector asks for its own client). Not secrets, but check: `LIVE_GUESTS_OFF` unset keeps guests on (set it to a non-empty value to switch guests off).

Bindings in the top-level config that must exist on the account: D1 `DB`, R2 `FILES` (`harbourmaster-files`), `BROWSER`, `LOADER`, `EMAIL`, rate limits `EXPORT_LIMIT` (2012), `SHARE_OPEN_LIMIT` (2001), `SHARE_CALL_LIMIT` (2007), `APP_API_LIMIT` (2004), Durable Objects `MACHINE_RELAY`, `MANAGED_POLLER`, `PI_RUN`, `GUEST_RUN`, `LINUX_VM`, `SESSION_STREAM`, `MAILBOX`, `APP_STORE`, `ARTIFACT_ROOM`, `LIVE_ARTIFACT_MAINTENANCE`, queue consumer `harbourmaster-mail-events`, container `VmSession` (needs Docker on the deploy machine). Vars: `PUBLIC_BASE_URL` production host, `MAIL_DOMAIN=agents.rockyshoreslabs.io`, `MAIL_ZONE_ID`, `MAIL_WORKER_NAME`. The cron `* * * * *` runs on production only.

Clerk: production publishable key comes from `apps/web/.env.production.local` at build time. Guest and mention mail need Email Sending on `agents.rockyshoreslabs.io`.

## Deploy steps (Dom or an authorised session, from `apps/web`, PATH with node)

1. Fix room admission time and the deck controls (see go/no-go). Rerun the latency and admission checks on staging. Record the version id.
2. `bun run build` and confirm `dist/server/wrangler.json` names Worker `harbourmaster`, the production host, D1 `harbourmaster`, R2 `harbourmaster-files`. Grep `dist/client` for the dev Clerk key host: it must be absent.
3. Set `ARTIFACT_VIEW_KEY`.
4. `wrangler d1 migrations apply DB --remote` (the `deploy` script does not apply migrations).
5. `bun run deploy` (`bun run build && wrangler deploy`).
6. Smoke: `/api/health`, sign in as a real member, create a document through the app, open it in two browsers, export one PDF, check `wrangler tail` for 403 on `/api/rooms/`. If a Durable Object behaves like old code after a few minutes, redeploy once.

## Rollback

Code: `wrangler rollback <previous-version-id>` (previous: `d23c5cb9-d46e-4afd-84c2-cdbf66866209`). This does not undo D1 migrations or DO class migrations. The migrations add tables and columns; the old code ignores them, so rolling back code only is safe unless a migration recreated an existing table (check during step 1). For data loss use D1 Time Travel to the bookmark taken before step 4: `wrangler d1 time-travel restore DB --bookmark <id>`. Guests can be switched off without a deploy-wide rollback by setting `LIVE_GUESTS_OFF`.
