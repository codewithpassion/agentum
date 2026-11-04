# EP.2 review

Implemented by Codex (gpt-6.1-sol), reviewed by Claude Opus.

## Round 1 (b0acbc0d): must-fix
- The rate limiter ran after D1 reads and a log write, so disabled, rotated and unknown ids were unthrottled.
- An approved grant carried to a new version re-created an endpoint a person had disabled. Decided per the spec: a row is made only when none exists for (artifact, name).
- Ten nits fixed in 10baa51c, including the access log label, waitUntil logging, one atomic batch and settings showing only the newest address.

## Round 2 (10baa51c): must-fix
- The Needs you test from EP.1 still expected the raw agent id. Fixed in 00a23082, along with an IP-only guard before the per-endpoint limit, error logging and spec wording.
- The `atomic.ts` change (`onResults` after commit) was reviewed and holds for D1 and bun:sqlite.

## Round 3 (00a23082): clean, reviewed by the controller

## Left
- The browser check moved to EP.4. Only runs can publish apps today, so nothing outside a run can make one until EP.4 opens the artifact tools to people over MCP.
- Nits: no test of `d1Atomic` passing `returning()` rows; the gateway test builds the publish batch by hand; `recordCall` param type could be named.
