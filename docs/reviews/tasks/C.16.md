# C.16 review

Task: Env secrets in the isolate as placeholders, filled in on the way out. Branch task/C.16-isolate-env-secret-placeholders. Status: review clean after 4 fix rounds.

## Verdicts

- Round 1 (d18a1a4): must-fix. A server that echoed the filled value into a redirect `Location` got it followed to a host that is not allowed, and the value showed in the result `url`.
- Round 2 (9d673f5): must-fix. The fix put the placeholder back for two spellings of the value. Other spellings still got through.
- Round 3 (ba13ae2): must-fix, 3 findings. The fold of tabs, percent-encoding, `+` and case still lost to a server that rewrote the value through URL parsing (full-width host labels, dot segments, bad escapes).
- Round 4 (6da3c98): must-fix, 1 finding. The controller chose a structural rule: once a call has filled a secret, a redirect is followed only to the exact same origin, any other 3xx is returned as the answer, headers are scrubbed and the result `url` is the one requested. The probes could not defeat it. `statusText` skipped the scrub.
- Round 5 (96fddb5): clean, 0 must-fix, 5 nits. `statusText` is scrubbed.

## What changed

- An env secret has `allowed_hosts` (migration 0011), validated with the proxy rule host schema, edited under Settings, Secrets.
- The isolate shell gets `$NAME` set to `hm-secret:NAME` for each granted env secret (cloud isolate, network on). The prompt lists the names and hosts.
- `fillHop` (`apps/web/src/server/web-fetch/hop-secrets.ts`) fills placeholders in the URL, header values and a text body just before each hop is sent. The hop that the fetcher keeps stays in placeholder form, so every redirect is checked again from placeholders. After a fill, only same-origin redirects are followed; the result `url` is the requested one and `scrubSecrets` swaps any echoed value in headers and status text for its placeholder. A refusal writes a refused `network.request` event with the reason. A fill writes `secret.injected` with names and host.
- The agent's Secrets tab shows, for an isolate agent, which granted secrets work and how.

## Nits left

- `hop-secrets.ts` `scrubSecrets` replaces one value at a time. If one secret's value equals another secret's name or is a substring of `hm-secret:NAME`, the output placeholder is mangled. No value leaks. A single combined regex would fix it.
- An env value above U+00FF can be filled into a text body, and the runtime decodes it as Latin-1 when a server echoes it in a response header, so the scrub misses that spelling.
- After a fill, a same-origin `Location` can name `hm-secret:OTHER` and get it filled if the host is allowed for OTHER. The value goes only to an allowed host.
- No test checks the header scrub on HEAD or 204 after a fill. They share `shownAnswer`.
- A redirect to another origin after a fill is returned as the answer, so `Authorization: Bearer $GH` to api.github.com then a 302 to codeload.github.com comes back as a 302 for the agent to follow itself.
- `IFS`, `PWD`, `PS4` and similar shell variable names are not reserved as secret names. An env secret named `IFS` breaks only the agent's own scripts.
- `curl -u user:$KEY` builds a base64 Basic header before the fetcher sees it, so the placeholder is not filled there.
- Skill scripts in a Dynamic Worker isolate already receive real env values through `PiRun#scriptSecrets`. This task leaves that unchanged.

## Ideas beyond scope

- Send env secrets to skill-script isolates as placeholders too, with the same fill step in `outboundFetch`.
- Scan the final (non-redirect) answer for the filled values, as proxy mode does, so a server echo does not reach the transcript.

## Steps for Dom

- Staging check from the task file: create the Supadata env secret with allowed host `api.supadata.ai`, grant it to the isolate agent, and in a new chat run `curl -H "x-api-key: $SUPADATA_KEY" https://api.supadata.ai/...`. The same call to example.com must be refused.
- Apply migration 0011 on staging and production D1.
