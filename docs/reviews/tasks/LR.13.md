# LR.13 review: workspace-wide Google OAuth client for connectors

## Verdict

Round 1 (25739f4, Sonnet high): must-fix. The shared secret could go to any token endpoint, because only the authorization endpoint host was checked and a connector's server picks both. Fixed in f761b92: both endpoints must be Google hosts (accounts.google.com and oauth2.googleapis.com, exact hostname) at start, code exchange and refresh. Round 2 (f761b92, fix commit only): clean. Then the controller's merge check failed: with an env file that lacks the two optional secrets, `Pick<Env, ...>` in `ComposeEnv` did not type-check. They are now declared as optional strings beside `MailEnv` in `compose.ts`, and `bun run check` passes with an env file that lacks both keys. Round 3 (that commit only): clean. One fix round for the code, one type fix after the merge check.

## What was built

Optional secrets `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (both or neither, in `apps/web/.env.example`, mapped in `compose.ts`). When a connector's endpoints are Google's and no client was typed on it, `start` copies the shared client into the connector's OAuth config as `source: "shared"` (secret encrypted with the connector's binding) and the authorize URL carries the env client ID. A typed client always wins. The connector summary reports `canRegister` for such a connector, so the client dialog does not open. Without the secrets, LR.11 behaviour is unchanged. The summary exposes booleans only.

## Nits left

- The new tests cover the start path only. The code-exchange guard (`connector-oauth.ts` `store`) and the refresh guard (`credentials.ts`) have no test of their own.
- `clientConfigured` checks that the deployment still has a shared client, not that the stored endpoints are still Google. Not reachable, since endpoints are fixed at discovery.
- The shared secret is copied into the connector at each start. After the Google secret is rotated, refresh uses the old copy and fails until the person reconnects.
- `start` rewrites the connector's config on every start, even when the shared client is unchanged.
- With `SECRETS_KEY` unset, `canRegister` is true but `start` throws a plain error (same as the registration path).
- `secrets.ts` reserved env names do not list the two new names.

## Ideas beyond scope

- Per-connector scope list (see LR.11), so Gmail can be limited to readonly.

## Steps for Dom

- Set the two secrets on the Worker: `wrangler secret put GOOGLE_OAUTH_CLIENT_ID` and `wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET` (add them to `apps/web/.env.local` for local dev).
- In Google Cloud, add `<app origin>/api/connectors/oauth/callback` as an authorised redirect URI on the shared client, for each environment (production, staging).
- Existing Google connectors that have no typed client pick the shared one on their next Connect.
