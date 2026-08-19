# Progress Log

A reverse-chronological log of implementation cycles in this project — what was
done, what went wrong, and what to avoid next time. Newest entry first.

---

## Cycle 1 — Bootstrap app with Clerk auth + dev login (2026-08-19)

**Goal:** Bootstrap the app (Workers + Hono + TanStack Start + Clerk) through to a working custom /login page with one-click dev login.

**What we did:**
- Set up Cloudflare Workers + Hono + TanStack Start + Clerk (7ecc06f)
- Converted to Turborepo, moved the front end into apps/web (e6536d7)
- Added `GET /api/dev-login`: mints a Clerk sign-in token for a dedicated dev user and redeems it at `/dev-login` via `signIn.ticket` -> `signIn.finalize`, establishing a real session without a password touching the browser (f79532b)
- Gated dev login behind `DEV_LOGIN_EMAIL`/`DEV_LOGIN_PASSWORD` in `apps/web/.env.local`; their absence is the safety switch that keeps the route disabled in deployed environments
- Added `apps/web/scripts/create-dev-user.ts` (`bun run create-dev-user`) to create/refresh the dev Clerk user
- Moved Clerk sign-in off Clerk's hosted Account Portal onto a custom `/login` route (renamed from `/demo/clerk`), replacing the header's default `SignInButton` with a link to it, and removed the now-dangling "Demos > Clerk" nav entry (a2f0ade)
- Documented the dev login flow in AGENTS.md, CLAUDE.md, and .claude/CLAUDE.md so agents know to use it instead of Clerk's UI

**Lessons learned:**
- Clerk's default `SignInButton` redirects to the hosted Account Portal, which breaks a "single custom login page with a dev login option" UX — needed an explicit `/login` route + link instead of the default component

**Avoid next time:**
- Don't set `DEV_LOGIN_EMAIL`/`DEV_LOGIN_PASSWORD` outside `apps/web/.env.local` — their presence is what enables the dev-login route, so leaking them to a deployed environment would expose it
