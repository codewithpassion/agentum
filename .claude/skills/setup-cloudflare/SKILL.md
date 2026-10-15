---
name: setup-cloudflare
description: Connect apps/web to a Cloudflare account and do the first deploy - wrangler login check, account into .env.local, the D1 database and its migrations, Worker secrets from .env.local, deploy, health check. Use when project-init reaches Cloudflare or the user asks for a first deploy.
allowed-tools: AskUserQuestion, Bash(bun:*), Bash(cp:*), Bash(curl:*), Bash(rm:*), Bash(git:*)
---

# Set up Cloudflare

Puts the Worker named in `apps/web/wrangler.jsonc` on the user's Cloudflare
account, with the D1 database it reads. The only tracked file this touches is
`wrangler.jsonc`, and only to record the D1 `database_id`. Leave that change
uncommitted and hand it back.

Run wrangler from the repo root as `bun x wrangler --cwd apps/web …`, so it
finds `wrangler.jsonc` and reads `apps/web/.env.local`. Change `.env.local` only
through `env.ts`; reading it would put secrets in the transcript.

## 1. Login

`bun x wrangler --cwd apps/web whoami`. Not logged in: the login is a browser
OAuth flow, so ask the user to run `! bun x wrangler login` and wait for them. If they would rather not right now, stop and say so in the
hand-back.

Done when `whoami` lists at least one account.

## 2. Account

One account listed: nothing to do. Several: ask with `AskUserQuestion` which
one, then

```bash
cp -n apps/web/.env.example apps/web/.env.local
bun .claude/skills/setup-cloudflare/env.ts account <account-id>
```

Wrangler reads `CLOUDFLARE_ACCOUNT_ID` from `.env.local` next to its config.

Done when `bun x wrangler --cwd apps/web secret list` either lists secrets or
says the Worker is not found. Both mean the account resolved; an account picker
error means it did not.

## 3. Ask before deploying

The deploy creates a public `workers.dev` URL, and the D1 database in step 4 is
also created on the account. Ask with `AskUserQuestion`: "Deploy to Cloudflare
now?" No: go to step 6.

## 4. Database

The Worker's `DB` binding needs a real D1 database; `database_id` in
`wrangler.jsonc` still holds the `"local"` placeholder. Use the `database_name`
already in that binding as `<name>`.

```bash
bun x wrangler --cwd apps/web d1 create <name>
bun x wrangler --cwd apps/web d1 info <name> --json
bun .claude/skills/setup-cloudflare/env.ts database <uuid it printed>
bun x wrangler --cwd apps/web d1 migrations apply DB --remote
```

`d1 create` fails if the name is taken; that is fine when the database is the
user's own, so go straight to `d1 info` for the uuid. `migrations apply` is what
creates the tables, and it has to run before the first request hits `/notes`.

Done when `d1 migrations apply DB --remote` reports the migrations as applied.

## 5. Deploy

```bash
bun run --cwd apps/web build
bun .claude/skills/setup-cloudflare/env.ts secrets-file
bun x wrangler --cwd apps/web deploy --secrets-file <path it printed>
rm <path it printed>
```

`secrets-file` selects the keys the deployed Worker reads and prints the path
plus the key names; if it prints "Nothing to upload", deploy without the flag.
The secrets ride along with the deploy because `wrangler secret put` needs a
Worker that already exists. Run the `rm` whether or not the deploy succeeded;
the file holds secrets.

Verify: `curl -s <deployed URL>/api/health` returns `{"status":"ok"…}`, and
`curl -s <deployed URL>/notes` does not show the "Could not reach D1" panel. A
new `workers.dev` name can take a minute to resolve; retry a few times before
calling it a failure.

Done when both checks pass and `bun x wrangler --cwd apps/web secret list` shows
the uploaded names.

## 6. Hand back

Report the account, the Worker name, the D1 database name and the URL (or that
the deploy was skipped), plus the uncommitted `wrangler.jsonc` diff if step 4
wrote a `database_id`. Leave to the user:

- Committing that `database_id`. It is not a secret, and without it a fresh
  clone deploys against the `"local"` placeholder.
- Every later migration needs `bun x wrangler --cwd apps/web d1 migrations apply
  DB --remote` before the deploy that depends on it.
