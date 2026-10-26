# X.10 review: key-authenticated admin API

## Verdicts

Round 1 (2c550f7): must-fix. Write keys could not assign connectors in `create_agent` and `update_agent`, and a failed call left a half-made agent and an audit event. Fixed in 6a90a1f: write keys may assign connectors, `connectors.assertExist` runs before the agent is created, and connectors an agent already holds are skipped.

Round 2 (6a90a1f): clean.

## What was built

- `admin` key scope. Only an organisation admin (Clerk `org:admin`, carried as `Principal.isAdmin` on session principals) or an admin key mints one.
- `packages/services/src/admin.ts` and `admin-access.ts`: one method per tool, each checks the key, calls the service the UI uses and writes one `admin.action` event with actor kind `api_key`, the key id as actor id, and key name and owner in the payload. Payloads hold ids, names and hosts, never values.
- MCP tools: `create_agent`, `update_agent`, `create_inbox_thread` (write or admin key); `create_secret`, `grant_secret`, `revoke_secret`, `create_enrolment_code`, `create_api_key`, `revoke_api_key` (admin key). Not offered to other callers; the service refuses them with `ForbiddenError` as well.
- `assign_skill` and `unassign_skill` already worked for write keys. They stay open to write keys and now write the audit event when a key calls them.
- `secrets.grant` and `secrets.revoke` add and remove one grant.

## Decisions to know about

- The "403" for a write key is the service's `ForbiddenError`. Over MCP the tools are absent from the list, so a call gets "tool not found".
- Underlying services keep their own events (`agent.created`, `skill.assigned`, `api_key.created`) with the owning user as actor. The `admin.action` event is the extra, single audit record naming the key.
- The task's "network allow list" is the existing boolean `networkAccess` in the agent's runtime config. There is no host list on agents.
- `create_agent` and `update_agent` take `environment`, `networkAccess`, `maxTurns`, `model`, `instructions`, `name`, `slug` and `connectors`. The runtime is set on create only. `connectors` are added, never removed.
- An admin key can mint admin keys (the task says "up to the caller's own scope"), so a leaked admin key can outlive its own revocation by minting another. Admin keys also keep working after their creator stops being an org admin.

## Nits left

- `connectors.ts` `requireAssigner` also guards `unassign`, so write keys could unassign connectors at the service level. Nothing key-authenticated reaches it today.
- `update_agent` on an archived agent saves the fields and writes the event, then fails when assigning connectors.
- The new connectors test in `admin.test.ts` does not check that an existing credential mode survives a repeat update.
- The key dialog still says "Write keys can also send messages."
- `update_agent` reads and rewrites `runtimeConfig` without a guard against a concurrent change.
- No test covers `build-context.ts` passing `orgRole` through, and none shows an `assign_skill` call through the route writing its audit event.

## Ideas beyond the scope

- Record the minting key on `api_keys` (a `created_by_key` column) so a chain of minted keys can be revoked together.
- Re-check `org:admin` for an admin key's owner on use.
- An HTTP route set next to the MCP tools, if the coordinator prefers plain HTTP.

## Steps for Dom

- Staging check from the task: with an admin key, create an agent, a proxy secret granted to it, an inbox thread, an enrolment code and a desk key, then revoke the key. Mint the first admin key in Settings > API keys as an org admin on staging.
- Clerk must put `org_role` in the session token (the default). The UI and `isAdmin` rely on it.
