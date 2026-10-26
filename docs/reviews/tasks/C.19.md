# C.19 review: hide secrets typed into tool inputs in run transcripts

Branch task/C.19-transcript-secret-scrub. Final head is recorded in the dispatcher report.

## What was built

`packages/services/src/events/scrub.ts` redacts the text of `tool.call` and `tool.result` payloads before `events.append` stores them. It covers credential names (`Authorization`, `Proxy-Authorization`, `Cookie`, `X-Api-Key`, `api_key`, `token`, `password`, `secret`) in header, flag, JSON and shell-escaped forms, bare scheme words (`Bearer`, `Basic`, `OAuth`, `Token`) followed by a credential-shaped word, and well-known token formats (`sk-`, `sk-ant-`, `sk-or-`, `ghp_`, `github_pat_`, `xoxb-`, `xoxp-`, `AKIA`, JWTs). Matches become `[redacted]`. Cloudflare, Managed and machine runs all store tool events through `runs.ingestRunEvents` and then `events.append`, so the one function covers every runtime. The model's resume context is not rebuilt from events, so it needed no change. `packages/protocol/src/masker.ts` now also masks a granted secret's base64 (with and without a trailing newline), URL-encoded and form-encoded shapes with `[secret:NAME]`. A 1 MB output scrubs inside a set budget in the tests.

## Verdicts

- Round 1 (747233b): must-fix. The bare scheme word rule redacted prose when the next word ended in punctuation ("Basic authentication.", "Token expired.").
- Round 2 (bdb3989): clean.

## Nits left

- Capitalised prose after a scheme word still matches ("Basic Authentication is required", "Token Management page"). The same as before the fix.
- A bare scheme word followed by an all-lowercase token with dots or hyphens is no longer redacted. After an `Authorization:` header it is still caught.
- Names glued to letters are not matched (`PGPASSWORD=`, `AUTHTOKEN=`, `APITOKEN=`).
- A `key` suffix redacts source code such as `primary_key = True` and `cache_key = ...` in tool results that read files.
- "The token: is invalid" becomes "The token: [redacted]".
- A query parameter redacts to the end of the line, so `curl "https://x/api?token=a&page=2" -o out` loses the rest of the command.
- CLI flag forms are not covered: `--password X`, `--token X`, `-u user:pass`, `mysql -p'pw'`.
- The scrub runs over the whole payload before `capPayload` moves a large one to the blob store, not over capped text only. Timing is within budget.
- The base64 needle of a very short granted value can match inside unrelated base64 data. The raw needle already had this risk.
- The task file writes the placeholder as `[secret NAME]`, the existing masker writes `[secret:NAME]`. The code keeps the colon form.

## Ideas beyond scope

- Scrub CLI flag forms and `user:pass@host` URLs.
- Run the same scrub over `library.command` and `network.request` event text.

## Steps for Dom

None. After merge, the controller runs the staging check: an agent runs `curl -H "x-api-key: sk-test-1234567890abcdef" https://example.com` and the transcript and Log show `[redacted]`.
