# TX.13 review

Verdict: no separate reviewer round. The change is two guards and one test, and the TX gate reviewer's own scratch test is the proof. Dom asked for a fast fix.

- The retry query matches only posts with author `system` of kind `user`, the author `postNotice` writes when `authorAgentId` is null.
- `retryNoticeWake` returns no runs for any other post.
- The service test in `packages/services/src/inbox-notice.test.ts` fails without the guards and passes with them.

Browser steps skipped: none were in the task.
Nits left: none. Ideas beyond scope: none.
Steps for Dom: deploy after merge.
