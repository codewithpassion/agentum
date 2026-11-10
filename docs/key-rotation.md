# Rotating SECRETS_KEY and RUN_TOKEN_KEY

Each key has an optional partner secret, `SECRETS_KEY_PREVIOUS` and `RUN_TOKEN_KEY_PREVIOUS`. A deployment without them behaves as before. While one is set, the Worker reads with both keys and writes with the current one only:

- `SECRETS_KEY`: encrypting always uses the current key. Decrypting tries the current key, then the previous one. `decryptSecret` still checks the workspace, table, row and field binding under the old key.
- `RUN_TOKEN_KEY`: run, session and agent tokens are signed with the current key. A token the current key did not sign still verifies under the previous key.

Cloudflare never returns a secret's value, so keep the old value in the password manager before you start. An invalid previous key is refused when the key is first used, so a typo shows up as failing secret reads and 401s on run tokens, not as values that quietly stop opening. Check a new previous key right after you set it.

Do staging first (`--env staging` on every command below). Production commands have no `--env`.

## SECRETS_KEY

1. Generate the new key: `openssl rand -base64 32`. Store it in the password manager.
2. From `apps/web`, put the old value in the previous slot, then the new value in the main slot. Each `wrangler secret put` deploys.
   `bunx wrangler secret put SECRETS_KEY_PREVIOUS` (paste the old key)
   `bunx wrangler secret put SECRETS_KEY` (paste the new key)
   From here every value still reads, and new writes use the new key.
3. Dry run the re-encryption. The keys go in the environment, not on the command line:
   `NEW_SECRETS_KEY=<new> OLD_SECRETS_KEY=<old> bun run rotate-secrets-key --remote`
   The script reads its own variable names because bun loads `apps/web/.env` and `.env.local`, which hold the local dev `SECRETS_KEY`.
   It lists, per table and column, how many values it would move, how many are already under the new key, and the ids of rows that open under neither key.
4. Run it again with `--apply`. Each update also checks the old column value, so a row the app changed in the meantime is skipped.
5. Run the dry run once more. It must report 0 to move. A row that stays "unreadable" opens under neither key. Find the key it was written under, or have the person enter the value again. Production still holds rows from before the v2 cutover (`credentials` marked `needs_auth`, older `artifact_shares`) that were written under the lost pre-v2 key. They stay unreadable and the script exits 1 for them. That is expected, as long as nothing else is listed.
6. Only then remove the old key: `bunx wrangler secret delete SECRETS_KEY_PREVIOUS`. Values that were not moved stop reading after this.

What the script covers: `secrets.value_enc`, `credentials.secret`, `workspace_anthropic_keys`, `workspace_model_keys`, `slack_apps` (bot token and signing secret), `a2a_connections.outbound_credential`, `a2a_push_configs` (authentication and token), `a2a_outbox` (headers, and the token in a `pair_activate` body), `artifact_shares.token_encrypted` and the client secret inside `connectors.oauth`. A new encrypted column must be added to `TARGETS` in `apps/web/scripts/rotate-secrets-key-helpers.ts`, with the same binding the service uses.

Two values are derived from the key text itself, so they change at once under the new key and are not re-encrypted: the per-task webhook token of an A2A call and the pairing code. A task still waiting for approval when you rotate loses its push registration and is polled instead. A pairing that is open at that moment shows a new code when it is started again.

## RUN_TOKEN_KEY

1. Generate the new key as above.
2. Put the old value in `RUN_TOKEN_KEY_PREVIOUS`, then the new one in `RUN_TOKEN_KEY`.
3. Wait 7 days. Nothing needs re-signing. A run token lives 12 hours at most, but a managed session token (`ag_ses_`) has no age limit and sits in Anthropic's vault, and a session can be reused for 7 days (`SESSION_MAX_AGE_MS`). A run on a session still open when the previous key goes is refused by the platform MCP, and nothing closes that session. To rotate sooner, close the open managed sessions first.
4. Remove the old key: `bunx wrangler secret delete RUN_TOKEN_KEY_PREVIOUS`.

## Local

`bun run rotate-secrets-key --local` works the same way against Miniflare's database in `apps/web/.wrangler`, with `NEW_SECRETS_KEY` and `OLD_SECRETS_KEY` from your shell.
