---
name: setup-previews
description: Turn on pull request previews - the staging Worker and its D1 database, the first staging deploy, a Cloudflare API token and GitHub secrets for .github/workflows/preview.yml, then a test PR. Use when the user asks for PR previews, preview deployments or a staging environment.
allowed-tools: AskUserQuestion, Bash(bun:*), Bash(gh:*), Bash(cf:*), Bash(curl:*), Bash(git:*)
---

# Set up pull request previews

Every PR gets `https://pr-<N>-<worker>-staging.<subdomain>.workers.dev`, a
preview of the staging Worker (`env.staging` in `apps/web/wrangler.jsonc`) with
its own D1 database. `.github/workflows/preview.yml` deploys it on every push
and deletes both when the PR closes. Production is never involved. How it
works: README "Pull request previews".

The workflow and `apps/web/scripts/preview.ts` are already in the repo. What is
missing is account state, which this skill creates. The only tracked file it
touches is `wrangler.jsonc`, to record the staging `database_id`. Leave that
uncommitted and hand it back.

Run wrangler from the repo root as `bun x wrangler --cwd apps/web …`.

## 1. Prerequisites

- The `setup-cloudflare` skill has run: `bun x wrangler --cwd apps/web whoami`
  lists the account. If not, run that skill first.
- The account is enrolled in the Worker Previews beta. `wrangler preview` fails
  with a clear error if not; the user enables it in the dashboard.
- `gh auth status` succeeds and `gh repo view` shows the repo the workflow will
  run in.
- `cf --version` is 1.0.0-beta.10 or newer (`bun add -g cf` installs it), and
  `cf auth login` has run. Both are browser flows: ask the user to run
  `! cf auth login` and `! gh auth login` themselves.

Done when all four checks pass.

## 2. Ask before creating anything

Steps 3 to 5 create a staging Worker with a public `workers.dev` URL, a D1
database, an API token and two GitHub secrets. Ask with `AskUserQuestion`:
"Set up PR previews on <account> for <repo>?" No: stop and say so.

## 3. Staging database and deploy

```bash
bun x wrangler --cwd apps/web d1 create <worker>-staging
bun x wrangler --cwd apps/web d1 info <worker>-staging --json
bun .claude/skills/setup-previews/previews.ts staging-database <uuid it printed>
bun run --cwd apps/web staging:deploy
```

`<worker>` is the top-level `name` in `wrangler.jsonc`. `staging:deploy`
builds with `CLOUDFLARE_ENV=staging`, migrates the staging database (after the
build, so wrangler reads the staging config) and deploys `<worker>-staging`. The deploy is what turns on `preview_urls`: until it runs,
previews deploy but get no hostname.

Done when `curl -s <staging URL>/api/health` returns `{"status":"ok"}`.

## 4. Token and GitHub secrets

The account id comes from `bun x wrangler --cwd apps/web whoami`.

```bash
bun .claude/skills/setup-previews/previews.ts token <account-id> --dry-run
bun .claude/skills/setup-previews/previews.ts token <account-id>
```

The token gets Workers Scripts Write and D1 Write on the account and nothing
else. The script pipes it straight into `gh secret set CLOUDFLARE_API_TOKEN`
and never prints it. Claude Code's auto mode may block writing to a secret
store; if it does, ask the user to run the second command with `!`.

Done when `gh secret list` shows `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`.

## 5. Test PR

Ask first: this pushes a branch and opens a PR.

```bash
git switch -c preview-smoke-test
git commit --allow-empty -m "Test PR preview"
git push -u origin preview-smoke-test
gh pr create --fill --draft
gh pr checks --watch
```

Done when the PR has a comment with the preview URL, `<url>/notes` saves a note,
and after `gh pr close --delete-branch` the cleanup job passes and
`bun x wrangler --cwd apps/web d1 list` no longer shows
`<worker>-preview-pr-<N>`.

## 6. Hand back

Report the staging URL, the test preview URL and the uncommitted
`wrangler.jsonc` diff. Tell the user:

- Preview URLs are public. To put them behind a login, turn on Cloudflare
  Access for previews: Workers and Pages, the staging Worker, Settings,
  Domains and Routes.
- Secrets the app needs go into the preview base config with
  `bun x wrangler --cwd apps/web preview base-config secret put <NAME> --env staging`.
  A preview copies the base config once, when it is created, so existing
  previews keep the old values until deleted
  (`bun run --cwd apps/web preview:delete pr-<N>`) and re-run.
