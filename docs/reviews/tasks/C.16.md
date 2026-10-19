# C.16 review

Task: Env secrets in the isolate as placeholders, filled in on the way out. Branch task/C.16-isolate-env-secret-placeholders. Status: blocked after two fix rounds, three open must-fix findings.

## Verdicts

- Round 1 (d18a1a4): must-fix. A server that echoed the filled value into a redirect `Location` got it followed to a host that is not allowed, and the value showed in the result `url`.
- Round 2 (9d673f5): must-fix. The fix put the placeholder back for two spellings of the value (raw and `encodeURIComponent`). Other spellings (lower-case hex, partial encoding, a space for `+`, double encoding, tabs, case) still got through.
- Round 3 (ba13ae2): must-fix, 3 findings. The fix now folds tabs, percent-encoding, `+` and case before looking for the value in the `Location`, requires the redirect host to be allowed for every secret the hop filled, and no longer repeats the name of an ungranted placeholder. No attempt sent a value to a host that is not allowed.

## What changed

- An env secret has `allowed_hosts` (migration 0011), validated with the proxy rule host schema, edited under Settings, Secrets.
- The isolate shell gets `$NAME` set to `hm-secret:NAME` for each granted env secret (cloud isolate, network on). The prompt lists the names and hosts.
- `fillHop` (`apps/web/src/server/web-fetch/hop-secrets.ts`) fills placeholders in the URL, header values and a text body just before each hop is sent. The hop that the fetcher keeps stays in placeholder form, so every redirect is checked again from placeholders. A refusal writes a refused `network.request` event with the reason. A fill writes `secret.injected` with names and host.
- The agent's Secrets tab shows, for an isolate agent, which granted secrets work and how.

## Open findings (round 3)

1. `hop-secrets.ts:184-208` (must-fix). The fold looks at the raw `Location` text, and `new URL()` rewrites the host afterwards. With a wildcard grant such as `*.example.com`, a server on that host can send a full-width, soft-hyphen or ideographic-full-stop spelling of a value that works as a host label, and the plain value then lands in hop 2's host name, the result `url` and the Log `host` field.
2. `hop-secrets.ts:184-208` (must-fix). A value containing `/` can be rebuilt by path cleanup (`Ab/./Cd`, `Ab/zz/../Cd`, `Ab\Cd`) in hop 2's URL and the result `url`. Only the allowed host and the tool result see it, not the Log.
3. `hop-secrets.ts:131-139` (must-fix). One bad escape (`%ZZ`, a lone `%C3`) in the `Location` makes `decodeURIComponent` throw. The fallback decodes byte by byte, so a non-ASCII value in lower-case percent hex is not matched.

The reviewer's suggested fix for 1 and 2 is to fold the parsed `new URL(restored, base).href` as well. Finding 3 needs UTF-8-aware decoding of each valid run of escapes. Another route that closes all three: after a hop that filled a secret, follow a redirect only to the same origin, and show the first request's placeholder-form `url` in the result instead of the final one.

All three need a server that the user allowed to receive the value, and that server can already put the value into its final answer, which the task accepts. The fetcher never sent a value to a host that is not allowed in any probe.

## Nits left

- `web-fetch.ts:313`: a refused redirect records the host of the `Location`, which is the server's text. Fixing finding 1 on the parsed form closes it.
- `web-fetch.ts:348`: every hop runs `fillHop`, so a server can write `hm-secret:OTHER` into a `Location` and get another granted secret filled if the next host is allowed for it. The value goes only to an allowed host. Filling only the names the first request held would close it.
- A redirect after a filled hop must go to a host allowed for every filled secret. `Authorization: Bearer $GH` to api.github.com then a 302 to codeload.github.com is refused although the cross-origin `authorization` header would be dropped. This is deliberate and costs some function.
- A very short or common value (minimum 8 characters) makes the restore step refuse legitimate redirects.
- `IFS`, `PWD`, `PS4` and similar shell variable names are not reserved as secret names. An env secret named `IFS` breaks only the agent's own scripts.
- `curl -u user:$KEY` builds a base64 Basic header before the fetcher sees it, so the placeholder is not filled there.
- Skill scripts in a Dynamic Worker isolate already receive real env values through `PiRun#scriptSecrets`. This task leaves that unchanged.

## Ideas beyond scope

- Send env secrets to skill-script isolates as placeholders too, with the same fill step in `outboundFetch`.
- Scan the final (non-redirect) answer for the filled values, as proxy mode does, so a server echo does not reach the transcript.

## Steps for Dom

- Staging check from the task file: create the Supadata env secret with allowed host `api.supadata.ai`, grant it to the isolate agent, and in a new chat run `curl -H "x-api-key: $SUPADATA_KEY" https://api.supadata.ai/...`. The same call to example.com must be refused.
- Apply migration 0011 on staging and production D1.
