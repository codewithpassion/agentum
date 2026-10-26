---
id: C.19
title: Hide secrets typed into tool inputs in run transcripts
milestone: C
size: M
status: in_progress
depends_on: []
branch: task/C.19-transcript-secret-scrub
---

Asked for by Dom on 19 Oct 2026. C.15's review noted that tool inputs for `bash`, `web_fetch` and other tools are stored verbatim in `tool.call` run events (`pi-run-events.ts`), and `stripSecrets` misses a token inside a script or a request body. A token an agent or person types into a command is readable in the run transcript and the Log. C.16's placeholders keep granted secrets out, but not values typed by hand.

## Scope

- Before a `tool.call` or `tool.result` event is stored, scrub the input and output text:
  - the real values of every secret granted to the run (exact match, and its base64 and URL-encoded forms), replaced with `[secret NAME]`;
  - values of common credential headers and fields (`Authorization`, `Proxy-Authorization`, `Cookie`, `X-Api-Key`, `api_key`, `token`, `password`, `secret`), replaced with `[redacted]`;
  - strings that look like well-known token formats (for example `sk-ant-`, `sk-or-`, `sk-`, `ghp_`, `github_pat_`, `xoxb-`, `xoxp-`, `AKIA`, JWTs, `Bearer <token>`), replaced with `[redacted]`.
- Apply the same scrub to the transcript the model sees on resume only if that is where events are read back from; the live model context in a running turn stays unchanged.
- Apply it to all runtimes that write `tool.call` events (Cloudflare, Managed, machines), in one shared function in `@repo/services`.
- Keep it fast on large outputs (the scrub runs over capped text only).

## Check

- Tests: each pattern above is redacted in an input and an output; a granted secret's real value is replaced with its name in plain, base64 and URL-encoded form; ordinary text with similar words ("token count", "password reset page") is unchanged; a 1 MB output scrubs within a set time.
- `bun run check && bun run test && bun run build` pass.
- Live on staging (controller): an agent runs `curl -H "x-api-key: sk-test-1234567890abcdef" https://example.com`, and the transcript and Log show `[redacted]`.

## Log
- 2026-10-19: added at Dom's request. dispatched.
- 2026-10-26: re-dispatched to finish review; the previous controller session ended with 4 commits on the branch and no review.
- 2026-10-26: review clean after 1 fix round; merged at 5c7fe21, deployed to staging (88d14bdf). Live staging check running.
