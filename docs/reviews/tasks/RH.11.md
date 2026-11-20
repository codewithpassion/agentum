# RH.11 review

## Verdict

Round 1 at 7d75ee9: clean, no must-fix.

## Nits left

- The check compares whole origins, so `127.0.0.1:3917` against a `localhost:3917` PUBLIC_BASE_URL reads as a mismatch.
- `*.localhost` hostnames are not treated as local.
- On the mismatch path `claimRun` can throw a conflict when another run of the agent is live. The error then reaches the sender, with the run row already written. Dev only.
- Runs offered by the sweep or a Durable Object have no request origin, so they skip the check.
- No test covers the compose wiring that passes `requestOrigin` in dev only.

## Ideas beyond the scope

- Check `PUBLIC_BASE_URL` against the dev server's port once at startup and warn in the log, so a mismatch shows before any run.

## Steps for Dom

None.
