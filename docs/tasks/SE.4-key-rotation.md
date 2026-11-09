---
id: SE.4
title: Rotation path for SECRETS_KEY and RUN_TOKEN_KEY
milestone: SE
size: M
status: todo
depends_on: []
branch: null
lane: services
executor: claude
---

From the 10 Nov 2026 review (M4). Neither key can be rotated today (`packages/services/src/crypto.ts`).

## Scope

- Decrypt accepts a second, older key. Encrypt always uses the current one.
- A script in `apps/web/scripts` re-encrypts every encrypted column under the current key, dry run unless `--apply`.
- Run tokens verify against the current and the previous key.
- A short runbook in `docs/`.

## Check

- Tests: a value written under the old key reads under the new pair, the script moves it, and it then reads with the new key alone.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
