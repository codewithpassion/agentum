---
name: add-clerk
description: Add Clerk auth to apps/web - copy in the provider, header user button, /login and dev login, wire the Hono and TanStack Start middleware, then connect it to a Clerk application. Use when project-init asks about auth, or the user asks for sign-in, users or login in this app.
allowed-tools: AskUserQuestion, Bash(clerk:*), Bash(bun:*), Bash(cp:*), Bash(curl:*), Bash(git:*), Read, Edit, Write
---

# Add Clerk

The boilerplate ships with no auth. This puts it back in two halves:

- Steps 1 to 8 are code. They need no Clerk account and end on a green build.
- Steps 9 to 12 connect the app to a real Clerk application and put its keys in
  `.env.local`.

Start from a clean `git status`, so the whole addition reviews as one diff. If
the tree is dirty, stop and ask the user to commit or stash first.

Every file this skill copies lives verbatim under `templates/`, mirroring its
path in the repo. The edits in steps 3 to 6 are the only hand-written code.

## 1. Copy the files in

From the repo root:

```bash
cp -r .claude/skills/add-clerk/templates/apps/web/. apps/web/
```

That lands six files, one of them over an existing file:

- `apps/web/src/integrations/clerk/provider.tsx` - `<ClerkProvider>` with an
  `appearance` config, because Clerk renders in a shadow root the app
  stylesheet never reaches.
- `apps/web/src/integrations/clerk/header-user.tsx` - `<UserButton>` when signed
  in, a "Sign in" link when signed out.
- `apps/web/src/routes/login.tsx` - Clerk's `<SignIn routing="hash" />` plus the
  dev login button.
- `apps/web/src/routes/dev-login.tsx` - redeems a dev login token.
- `apps/web/scripts/create-dev-user.ts` - creates the dev login user through
  Clerk's Backend API.
- `apps/web/src/server/trpc/context.ts` - replaces the no-auth version. The
  tRPC context's `userId` now comes from the Clerk session: `getAuth(c)` for
  calls over `/api/trpc`, `auth()` for in-process calls during SSR. That is
  what makes `protectedProcedure` let signed-in users through.

Done when all six exist and `git diff --stat` shows
`apps/web/src/server/trpc/context.ts` modified.

## 2. Dependencies and scaffold metadata

From `apps/web`:

```bash
bun add @clerk/backend@^3.16.8 @clerk/hono@^0.1.69 @clerk/tanstack-react-start@^1.4.21
```

This rewrites `package.json` and `bun.lock` together.

In `apps/web/package.json`, add the script back between `cf-typegen` and
`deploy`, keeping the list alphabetical:

```json
    "create-dev-user": "bun scripts/create-dev-user.ts",
```

In `apps/web/.cta.json`, put `"clerk"` first in `chosenAddOns`:

```json
  "chosenAddOns": ["clerk", "cloudflare"]
```

Done when `bun install` is clean and the three packages are in `dependencies`.

## 3. Wire the Worker

`apps/web/src/server.ts`. Add two imports above the existing ones, so the block
reads:

```ts
import { createClerkClient } from "@clerk/backend";
import { clerkMiddleware, getAuth } from "@clerk/hono";
import { trpcServer } from "@hono/trpc-server";
import handler from "@tanstack/react-start/server-entry";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { createHonoContext } from "./server/trpc/context.ts";
import { appRouter } from "./server/trpc/router.ts";
```

Then replace the one-line health route

```ts
app.get("/api/health", (c) => c.json({ status: "ok" }));
```

with the middleware, the health route that reports the caller, and the dev
login route:

```ts
app.use("*", clerkMiddleware());

app.get("/api/health", (c) => {
  const auth = getAuth(c);
  return c.json({ status: "ok", userId: auth?.userId ?? null });
});

// One-click dev login: mints a one-time Clerk sign-in token for the dev user
// and hands it to /dev-login to redeem client-side. Only active when
// DEV_LOGIN_EMAIL is configured, which must never be set in a deployed
// environment - that absence is the safety switch for this route.
app.get("/api/dev-login", async (c) => {
  const email = c.env.DEV_LOGIN_EMAIL;
  if (!email) {
    return c.text("Dev login is not configured.", 404);
  }

  const clerkClient = createClerkClient({ secretKey: c.env.CLERK_SECRET_KEY });
  const { data } = await clerkClient.users.getUserList({
    emailAddress: [email],
  });
  const [user] = data;
  if (!user) {
    return c.text(
      `Dev login user ${email} does not exist yet. Run "bun run create-dev-user" in apps/web.`,
      404
    );
  }

  const { token } = await clerkClient.signInTokens.createSignInToken({
    expiresInSeconds: 60,
    userId: user.id,
  });

  return c.redirect(`/dev-login?token=${encodeURIComponent(token)}`);
});
```

Leave the `/api/trpc/*` block where it is, below these routes. The tRPC
context calls `getAuth(c)`, which only works after `clerkMiddleware()` has run,
and Hono runs middleware in the order it is registered. The `app.all("*", ...)`
catch-all stays last: Hono matches in order, so a route added after it never
runs.

## 4. Wire TanStack Start

`apps/web/src/start.ts`. Add the import as the first line:

```ts
import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
```

and put it in the middleware array after CSRF:

```ts
  requestMiddleware: [csrfMiddleware, clerkMiddleware()],
```

Order matters: CSRF runs first.

## 5. Wrap the app

`apps/web/src/routes/__root.tsx`. Add the import on its own line between the
`ThemedToaster` import and the `appCss` import, with a blank line on each side:

```tsx
import ThemedToaster from "../components/themed-toaster";

import ClerkProvider from "../integrations/clerk/provider";

import appCss from "../styles.css?url";
```

Then wrap the existing `<TooltipProvider>` block inside `<body>`, leaving
`<Scripts />` outside it:

```tsx
        <ClerkProvider>
          <TooltipProvider>
            ...unchanged children...
          </TooltipProvider>
        </ClerkProvider>
        <Scripts />
```

The wrap re-indents everything inside by two spaces. Step 8 runs
`ultracite fix`, which settles the formatting.

## 6. Header

`apps/web/src/components/header.tsx`. Add the import (the `.tsx` extension is
part of the path):

```tsx
import ClerkHeader from "../integrations/clerk/header-user.tsx";
```

between the `Button` import and the `ThemeToggle` import. Then render it in the
right-hand `div`, above `<ThemeToggle />` with one blank line between them:

```tsx
          <ClerkHeader />

          <ThemeToggle />
```

## 7. Env vars

Clerk reads five names. Put them at the top of `apps/web/.env.example`, above
the `CLOUDFLARE_ACCOUNT_ID` block:

```dotenv
# Clerk
# Clerk publishable key (required) - exposed to the client via Vite
VITE_CLERK_PUBLISHABLE_KEY=
# Clerk publishable key (required) - read by the Hono @clerk/hono middleware (same value as above)
CLERK_PUBLISHABLE_KEY=
# Clerk secret key (required)
CLERK_SECRET_KEY=

# One-click dev login (optional). When set, GET /api/dev-login signs in as
# this Clerk user via a one-time sign-in token - no Clerk UI needed. Create
# the user with `bun run create-dev-user` after setting these.
# NEVER set these in a deployed environment: their presence is what enables
# the route, so leaving them unset in production is the safety switch.
DEV_LOGIN_EMAIL=
DEV_LOGIN_PASSWORD=

```

Three of those five belong on a deployed Worker. In
`.claude/skills/setup-cloudflare/env.ts`, fill the empty `DEPLOYED_KEYS` array
so `setup-cloudflare` uploads them with its deploy:

```ts
const DEPLOYED_KEYS: readonly string[] = [
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "VITE_CLERK_PUBLISHABLE_KEY",
];
```

`DEV_LOGIN_*` stays out of that list on purpose.

Then, from `apps/web`, regenerate the `Env` type and the route tree:

```bash
bun run cf-typegen
bun run generate-routes
```

`cf-typegen` reads the names in `apps/web/.env.local`, so that file needs the
five too or step 8's typecheck fails on them. It does not exist yet:
`cp apps/web/.env.example apps/web/.env.local`. It already exists (an earlier
`setup-cloudflare` run creates one): append the five `NAME=` lines, leaving the
values empty. `wrangler types` reads names, not values, and step 10 fills the
real keys in.

## 8. Check the code half

From the repo root:

```bash
bun x ultracite fix
bun run check
bun run build
```

Done when all three pass. `check` is `ultracite check` plus typecheck; a
`Property 'CLERK_SECRET_KEY' does not exist on type 'Env'` means step 7's
`cf-typegen` ran without those names in `.env.local`.

## 9. Clerk CLI and login

The rest of the skill talks to Clerk. Two rules for it:

- Run every `clerk` command from the repo root and pass `--app <id>` wherever
  the command accepts it. clerk 2.x resolves the linked app from the git
  directory, and from a subdirectory it resolves the wrong one.
- `.env.local` holds the secret key. Change it only through `clerk env pull` and
  `env.ts`; reading it would put the secret in the transcript.

`clerk whoami --json`. Command missing: `bun add -g clerk`. Not logged in: the
login is a browser OAuth flow with no headless form, so ask the user to run
`! clerk auth login` and wait for them.

Done when `whoami` prints an email.

## 10. Pick the application and pull keys

`clerk apps list --json` gives `application_id` and `name` per app. Ask with
`AskUserQuestion`: "Which Clerk application?" First option: create one named
after the README's display name (`My App`). Then the existing apps by name.

Create: `clerk apps create "<Display Name>" --json` and read the app id from its
output; if the shape is unclear, `clerk apps list --json` and find it by name.

```bash
clerk link --app <id>
cp -n apps/web/.env.example apps/web/.env.local
clerk env pull --app <id> --file apps/web/.env.local
bun .claude/skills/add-clerk/env.ts sync
```

`clerk env pull` merges into the file. It writes two of the three names the app
reads (which two depends on its framework detection); `sync` fills the third and
prints each name with its prefix.

Done when all three print, `pk_test_…` for the publishable keys and `sk_test_…`
for the secret.

## 11. Dev login

Ask with `AskUserQuestion`: "Enable the one-click dev login? (`/login` signs in
a dedicated dev user without Clerk's UI, local builds only.)" Options: yes as
`dev@<project-name>.test`, yes with another address (the user types it), no.

No: go to step 12. Yes:

```bash
bun .claude/skills/add-clerk/env.ts dev-login <email>
bun run --cwd apps/web create-dev-user
```

`create-dev-user` calls Clerk's Backend API with the secret key, so it doubles
as the proof that the keys work. If Clerk rejects the address, ask the user for
another and rerun both commands.

Done when it prints `Created dev user` or `Updated password`.

## 12. Docs

Replace the `## Auth` section of the root `CLAUDE.md` with:

```markdown
## Auth

Clerk. `apps/web/src/server.ts` runs `@clerk/hono`'s `clerkMiddleware()`, so
`getAuth(c)` works in any Hono route; `src/start.ts` wires the same auth into
TanStack Start, and `src/routes/__root.tsx` wraps the app in `<ClerkProvider>`.
`src/server/trpc/context.ts` puts the Clerk user id in `ctx.userId`, so
`protectedProcedure` admits signed-in users and answers 401 to everyone else.
Set `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` and
`VITE_CLERK_PUBLISHABLE_KEY` on a deployed Worker with `wrangler secret put`.

## Dev login (testing)

`apps/web` exposes a one-click dev login for local testing: `/login` has a
"Dev login (local only)" link (dev builds only) that hits `GET /api/dev-login`,
mints a Clerk sign-in token for a dedicated dev user, and redeems it at
`/dev-login` to establish a real session without going through Clerk's UI. Use
it to sign in as a real user when testing or driving the app via browser
automation, instead of going through Clerk's UI. Only active when
`DEV_LOGIN_EMAIL`/`DEV_LOGIN_PASSWORD` are set in `apps/web/.env.local` (never
set these in a deployed environment, since their absence is what disables the
route). Create/refresh the dev user with `bun run create-dev-user` from
`apps/web`.
```

In `README.md` and `apps/web/README.md`, replace the line

```markdown
There is no auth. To add it, run the `add-clerk` skill (`.claude/skills/add-clerk`).
```

with

```markdown
Auth is [Clerk](https://clerk.com): `/login` signs in, the header shows the
signed-in user.
```

In the root `CLAUDE.md` "Services and tRPC" section, replace

```markdown
  Without auth `ctx.userId` is always null, so protected procedures answer 401
  until the `add-clerk` skill replaces `context.ts` with a Clerk-aware one.
```

with

```markdown
  `context.ts` reads the Clerk session, so `ctx.userId` is the signed-in user
  or null.
```

In `apps/web/README.md`, replace the sentence

```markdown
With no auth, `userId` is always null. The `add-clerk` skill swaps this file for one that reads the Clerk session.
```

with

```markdown
`userId` comes from the Clerk session: `getAuth(c)` over HTTP, `auth()` during SSR.
```

## 13. Verify

Done means all five hold:

- `bun run check` and `bun run build` pass from the repo root.
- `apps/web/src/routeTree.gen.ts` lists `/login` and `/dev-login`. If it does
  not, `bun run --cwd apps/web generate-routes`.
- `bun run --cwd apps/web dev`, then `/login` renders Clerk's sign-in card. With
  the dev login enabled, its "Dev login (local only)" button signs you in and
  lands on `/`, and the header shows the user button.
- `curl -s localhost:3000/api/health` returns `{"status":"ok","userId":null}`
  when signed out.
- `curl -s localhost:3000/api/trpc/me` returns a 401 `UNAUTHORIZED` when signed
  out. Signed in with the dev login, the browser's devtools console
  `await (await fetch("/api/trpc/me")).json()` shows the user id. Anonymous
  procedures (`notes.list`) keep working either way.

## 14. Hand back

Report the Clerk app name and id, whether the dev login is on, and the diff.
Commit only if the user asks. Leave to the user:

- Every notes procedure is still a `publicProcedure`, so anonymous visitors can
  add notes on a deployed app. Making `notes.create` a `protectedProcedure` (in
  `apps/web/src/server/trpc/routers/notes.ts`) is a one-word change; ask
  whether they want it.
- The dev instance also serves the deployed Worker. A production instance is a
  separate `clerk deploy` wizard and needs a custom domain.
- If the Worker is already deployed, its Clerk secrets go up with the next
  `setup-cloudflare` deploy (step 7 added them to `DEPLOYED_KEYS`), or by hand
  with `wrangler secret put` from `apps/web`.
