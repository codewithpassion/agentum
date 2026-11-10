# SE.3 review

## Verdicts

Round 1, at 77e98b7: not clean. One must-fix: masking `run_requests.question_keys` leaves the runtime with no answer for a question that held a secret, because the runtime looks the answer up by its own question text. The test I had edited to match hid that.

Round 2, at 88b135b: clean. The masking of `question_keys` is reverted, the original logic and test are back, and a comment says why.

## Done

- `/api/dev-login` lives in `devRoutes` (`routes/dev.ts`), which `server.ts` mounts only when `import.meta.env.DEV`. The `DEV_LOGIN_EMAIL` check stays.
- `/api/health` returns `{ status: "ok" }` (`routes/health.ts`).
- `global_fetch_strictly_public` is in all three wrangler places, with a test that reads `wrangler.jsonc`.
- `cimdClientName` runs the client id through `isSafeUrl` before it fetches.
- Guest room tickets are signed through `guestTicketKey`, which throws without `ARTIFACT_VIEW_KEY`. `guestService` already refused to build without it; a test now pins that.
- The assistant excludes `create_trigger` and `set_trigger_enabled`. The second one mints a secret when it approves a proposed trigger. The assistant can no longer pause or resume a trigger.
- `enroll` spends the code in the same `atomic` call as the inserts, for the daemon, computer and roles bodies. Each insert is an `INSERT ... SELECT ... WHERE EXISTS (unspent code)`, and the spend comes last. A failed write leaves the code unspent. A code for a machine that was revoked since it was minted now stays unspent too, where it used to burn.
- `packages/services/README.md` has a "Trust rule for credentials" section, including that the admin check on a secret's mode change is not a boundary.

## Left open

`run_requests.question_keys` still stores the runtime's own question text, raw. Masking it in place is not possible: answers come back keyed by it. Masking would need answers matched by position, which changes `askUserQuestionAnswers` and the Rust client. `display` and the events stay masked. Options for Dom: leave it, clear the column once the request is answered or expired (nothing reads it after that), or match answers by position.

## Nits left

- `infra.ts` and `room-admission.ts` still build an empty ticket key without `ARTIFACT_VIEW_KEY`. Everything downstream refuses an empty key, so nothing is exposed.
- `spendOf` in `machines.ts` writes NULL for any machine column the caller leaves out, so a future column with a SQL default would get NULL. Correct for today's schema.
- Add a log line to the task file noting the `question_keys` item was left open (controller's file).

## Not verified

- Staging checks in the task file (the controller runs them after the merge).
- `src/server/live-artifacts/guest-execution.test.ts` fails on main too, with and without this change (a miniflare socket closes). Two proxy refresh tests failed once under full-suite load and passed alone.

## Checks

- Dev loopback peers still work with the flag: `bun scripts/e2e/a2a-two-deployments.ts` passed 6 of 6 against two `vite dev` servers on localhost over plain http.
- `bun run check`, `bun run build` and the `drizzle` grep on `apps/web/dist/client` pass. `bun run test` passes except the guest-execution test above.

## Steps for Dom

Decide the `question_keys` item above. Nothing else needs your accounts.
