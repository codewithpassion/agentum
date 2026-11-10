# SE.4 review

Branch task/SE.4-key-rotation. `SECRETS_KEY_PREVIOUS` and `RUN_TOKEN_KEY_PREVIOUS` are optional Worker secrets, and a deployment without them works as before. The runbook is `docs/key-rotation.md`.

## Verdicts

Round 0, commit c5fe49a: must-fix. The runbook said to wait 12 hours before dropping the previous run token key, but managed sessions can be reused for 7 days and carry an `ag_ses_` token signed under the old key. The script read `SECRETS_KEY`, which bun also loads from `apps/web/.env`, so a shell with only the old key set would have used the dev key as the new one.

Round 1, commit 1b25b94: clean. The script now reads `NEW_SECRETS_KEY` and `OLD_SECRETS_KEY`, and the runbook says 7 days.

## Nits left

- The sealed-values SQL file the script writes to `$TMPDIR` is not deleted. It holds ciphertext only.
- The "covers every table" test repeats the `TARGETS` list. It cannot catch a new encrypted column. Bindings in the script test are written by hand, so a binding that drifts in a service would not fail it.
- The all-columns test does not seal `a2a_push_configs.authentication`.
- `slack_apps.client_secret` is not in `TARGETS`. Nothing writes it today.

## Ideas beyond the scope

- `webhookToken` and the pairing code derive from the key text, so they change at once on rotation. Checking incoming webhook tokens against both keys would keep push working for tasks in flight. The runbook accepts the loss.
- A test that fails when a service adds an `encryptSecret` call whose table and column are not in `TARGETS`.

## Not verified

- Remote runs. The script ran against a local empty Miniflare database through real wrangler, and against a seeded in-memory SQLite in tests. It has not run against staging or production D1.
- Staging checks in the task file are the controller's.

## Steps for Dom

Nothing is required to merge. To rotate, follow `docs/key-rotation.md`: set `SECRETS_KEY_PREVIOUS` and `RUN_TOKEN_KEY_PREVIOUS` with `wrangler secret put`, and keep the old values in the password manager first.
