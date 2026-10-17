# S.3 review notes

Workspace secrets for agents. Branch task/S.3-agent-secrets.

## Verdicts

- Round 1 (d4ced96): must-fix, two items. This file was missing, and the sudoers rule that lets secrets reach Claude Code in multi-user mode needs `install-service` to run again, which nothing said. Both are dealt with in the fix commit, with eight of the nits.
- Round 2 (13e77d5): must-fix, two items. The relay's host re-check had no test, and a failed `secret.delivered` event could fail a managed launch after its message was sent. Both fixed, with the cloud script path made the same, and more environment names that can inject code refused.

## What was built

A secret has a name (an environment variable name), a value and a mode. The value is encrypted with `SECRETS_KEY` (AES-GCM, bound to workspace, table, row and field), and no read returns it: `list`, `create` and `update` give back the name, mode, rules and times, and the UI has no hint or last characters. A `proxy` secret has one to eight rules, each a host (exact or a `*.` wildcard), a header and a template with `{value}`. A wildcard matches subdomains at any depth and not the domain itself, as Anthropic's vault credentials do. Grants are per agent (`agent_secrets`, migration `0003`). Names that clash with the Worker's own secrets, the run token, `ANTHROPIC_*`, `CLAUDE*`, `HARBOURMASTER_*`, proxy and CA variables and the like are refused, and so is a value that starts with `hm_`, so none of Harbourmaster's own secrets can be put through the store.

| Surface | `env` secret | `proxy` secret |
|---|---|---|
| Cloud isolate (Dynamic Worker) | Set in the isolate's `env`, so `process.env.NAME` works. | The isolate's `globalOutbound` is `SecretsOutbound`, a Worker entrypoint made with `ctx.exports.SecretsOutbound({ props })` (ids only). It adds the rule's header to a request to a matching host, over https only, with `redirect: "manual"`, and passes other requests through unchanged. The value never enters the isolate. |
| Managed Agents | A vault `environment_variable` credential, unrestricted, header and body. | A vault credential holds the session token as `HARBOURMASTER_RELAY_TOKEN`, limited to the Worker's host. The agent calls `/api/egress/<host>/<path>`. |
| Machine | In the claim's `env`, merged into Claude Code's environment after the daemon's filter. | The same relay, with the run token as `HARBOURMASTER_RELAY_TOKEN`. No local HTTPS proxy. |

The relay (`apps/web/src/server/routes/egress.ts`) checks the run or session token, finds the agent's rules for the host (403 `host_not_granted` otherwise), runs the SSRF guard, forwards over https without following redirects, strips the client's `Authorization` (the relay token) and scrubs the answer. Guidance text for machines and managed agents names the variables and the relay address of each proxied host. The cloud prompt says what a script gets.

Everywhere: the runs service masks every granted value in ingested run events and in a run's result text and error with `[secret:NAME]` before they are stored, delivered or shown (the masker moved from the daemon to `@repo/protocol/masker`, with its tests, and the daemon masks claim env values too). The cloud tool answer is masked before the model sees it. `secret.delivered` is appended when a run receives secrets (a machine claim, a managed launch, each cloud script call) and `secret.injected` when the outbound entrypoint or the relay adds a header, both with names and hosts only.

## Decision: how env secrets reach a managed agent

Anthropic's API has no environment or session variables. The environment config holds only `networking` and `packages`, and a session takes agent, environment, vaults, resources and a budget. The one way to put a secret in the sandbox is a vault credential of type `environment_variable`, and it is not a plain variable. Found live on 17 Oct 2026: `$NAME` in the sandbox holds a 61 character placeholder (the first characters are `ANTHROPIC_SECR`, and its SHA-256 and length differ from the value), and Anthropic's egress swaps in the real value in a request header, and in the body when `injection_location.body` is true, for the hosts the credential allows (`limited` with `allowed_hosts`, or `unrestricted`).

So an `env` secret on a managed agent is a vault `environment_variable` credential with `networking: unrestricted` and header and body injection. Code in the sandbox can send `$NAME` anywhere, and cannot read, print, validate or sign with the raw value. The task's check says an env secret is "readable in its sandbox". The Anthropic API cannot give that, so the live check proves the useful part: the variable is set, and a request that carries it reaches a server with the real value in the header and the body. The guidance tells the agent this. The vault holds 20 credentials, shared by the MCP servers, the env secrets and the relay token, and a run over the limit fails with a message that says so. A granted secret's revision is part of the agent fingerprint, so a replaced, added or revoked secret starts a new session and vault instead of reusing the one that holds the old value.

The model refused to send `$KEY` to an unfamiliar host until the agent's instructions said that the address was the key's intended use, so the guidance text calls the relay the platform's own approved endpoint.

## Live checks

Local dev server (`vite dev` on a spare port), the workspace key from `apps/web/.env.local`, a local echo server and cloudflared quick tunnels (`--config /dev/null`), one for the echo server and one for the dev server so Anthropic could reach it. The scripts wrote secrets and runs into the local D1 database as the other `scripts/e2e` checks do and printed booleans only.

- Cloud isolate (faux model, a shared skill with `scripts/probe.ts`): the script's `process.env` held the env secret (its SHA-256 matched) and not the proxy secret's name. The echo server got the script's own header and the proxy secret's header. A script that printed the env secret came back as `[secret:PLAIN_KEY]` in the tool result. An agent with no grant got neither. 20 of 20 checks passed.
- Managed agent (Haiku): the sandbox variable had the placeholder's length. A request carrying `$PLAIN_KEY` in a header and in the body reached the echo server with the real value, through the relay, along with the relay's own header for the proxy secret. The session token did not reach the echo server. An agent with no grant had no variable and no relay token. 14 of 14 checks passed. The sessions and vaults the check made were deleted and its two agents archived. The `harbourmaster` environment already existed and was left.
- Machine (the daemon from source in `single_user` mode, real Claude Code with Haiku): the env secret reached the agent (SHA-256 matched), the relay added the proxy secret's header and did not forward the run token, and an echo server that reflected `x-plain: $PLAIN_KEY` produced `[secret:PLAIN_KEY]` in the result and the transcript. An agent with no grant had nothing set. 15 of 15 checks passed.
- Redaction in all three: no event of any run held a raw value, `[secret:PLAIN_KEY]` was in the transcripts, and `secret.delivered` and `secret.injected` were there.
- UI, in a browser: the Secrets page lists secrets with no value, creates one, and the agent's Secrets tab toggles a grant that survives a reload.

Service tests cover storage (encrypted, no read returns a value, a ciphertext moved to another row does not decrypt), grants per agent, host matching with wildcards and ungranted hosts, redaction of events and results, the machine claim, the managed launch, the relay (401 without a valid token, 403 for a host that is not granted, a grant of another agent) and the outbound entrypoint.

## Nits left

- `packages/services/src/secrets.ts`: `resolveForAgent`, `maskerFor` and `proxyFor` each query and decrypt every granted secret, and the outbound entrypoint and the ingest path call them for each request or batch. Fine at this scale. A per-run cache would cut the cost.
- `apps/web/src/server/pi-run.ts`: a cloud agent with no grant still gets the "granted" prompt sentence. The plain sentence is only used where no secrets port is passed.
- The managed credential cap reuses `MAX_SERVERS`, which now counts servers, env secrets and the relay token.
- `hostsOf` and `errorMessage` appear in two UI places each.
- On a failed save the Settings dialogs keep the typed value so the person can retry.
- The agent page's secret rows and the Settings table can clip their buttons inside a scroll container on narrow widths.
- A wall-time timeout in a script does not abort its outbound calls (C.12 nit, unchanged).

## Ideas beyond the scope

- Managed `proxy` mode can be native: a vault credential `limited` to the rule's hosts with header injection would add the header at Anthropic's egress, and the value would never pass through Harbourmaster. It needs the agent to write the header itself (`Bearer $NAME`) since the placeholder is substituted whole. Dom asked for the relay, so that is what is built.
- A per-skill grant (out of scope here) and S.4 for the Linux VM backend, whose `SandboxRunInput` already carries `env` and `proxy`.
- Secret rotation reminders, and an audit event for create, replace and delete.

## Steps for Dom

- Run `wrangler d1 migrations apply DB --remote` before the deploy: this task adds migration `0003`.
- Each machine in multi-user mode needs `harbourmaster install-service` run again (on the new daemon build). The sudoers rule now carries `SETENV` for the claude binary so `sudo --preserve-env` can pass the agent's secrets. Until it is run, a run of an agent with granted secrets on that machine fails to start, with sudo's "not allowed to preserve the environment" in the error. Agents with no secrets are not affected. `single_user` machines need nothing.
- Nothing new to set on the Worker: `SECRETS_KEY` and `RUN_TOKEN_KEY` are used as before.
- Managed Agents: a workspace's managed runs need `PUBLIC_BASE_URL` to be a public address, as before. The relay is at `<PUBLIC_BASE_URL>/api/egress/<host>/<path>`.
