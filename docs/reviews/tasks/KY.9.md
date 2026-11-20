# KY.9 review: a fake runtime that calls a connector tool

Branch `task/KY.9-a-fake-runtime-that-calls-a-connector-to`.

## Verdict per round

Round 1, commit 2c36204a: clean, no must-fix. Six nits, none fixed.

Browser check (fresh verifier, 1280x800, local dev server): Fake echo with Cloudflare Docs added, task text `tool:search_cloudflare_documentation durable objects alarms`. The run finished done. The log showed a `tools/list` pair and a `search_cloudflare_documentation` pair holding the Cloudflare glossary result, and the reply began "Used search_cloudflare_documentation:". Plain text still echoes. `tool:not_a_real_tool hello` ended with "not_a_real_tool is not on this agent's allowed tools, so the call was refused." No console or server errors.

## How it works

The mode is chosen by the agent's model name `fake-tool`, or by a `tool:<name>` marker in the task text (the marker names the tool and is stripped from the query). `createRunsService` learns the proxy through a new `proxy` dep, `{ baseUrl, fetch }`. The app builds it from `PUBLIC_BASE_URL` and `inProcessFetch`. It is read only when `devFakeRuntime` is true. The run token is signed by the runs service's own `signToken`.

## Nits left

- The "no person" test uses a stub that returns a connect link. The real proxy answers a run with no person with the `no_person` text, which has no link. The signed-in-person-without-a-sign-in case has no test of its own.
- `initialize` and `tools/list` show as tool calls in the action log.
- A task text that is only `tool:<name>` sends the marker as the query.
- The proxy's upstream MCP session is never closed with a DELETE.
- JSON-RPC ids skip numbers because notifications advance the counter.
- `proxyFetch` is built in every environment, though only dev reads it.
- The reply holds the tool's raw text. Cloudflare Docs answers XML, so the task page, which renders markdown, hides the tags and shows mostly the first URL. The log event has the full text.

## Ideas beyond the scope

- Pick the tool across all assigned apps, not only the first.
- Offer a person's Run now dialog a hint about the `tool:<name>` marker.

## Steps for Dom

None.
