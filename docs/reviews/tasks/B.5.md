# B.5 review record

Member live tool calls and storage procedures.

## Rounds

Round 1 (3bc8e75): not clean, two must-fix.
- Server keys were built over every workspace connector in creation order. A run builds them over its agent's assigned connectors in assignment order, so two connectors with the same name could swap. Fixed: `callableConnectors` uses the making agent's list, and the workspace list only for person-made artifacts. Test for duplicate names added.
- No refresh and retry on a connector 401. Fixed: `send` refreshes once like the connector proxy.

Round 2 (953f4d4): clean.

## Nits left

- `canWrite` from B.3 is not called before storage set and delete. Members write both areas, so behaviour is the same. The merge with B.3 should add the call, or B.8 should move storage onto B.3's `viewerStorage`.
- `AppStorePort` is declared in `packages/services/src/artifacts/storage.ts` as a subset (no `usage`, `wipe`) and B.3 declares the full one in `app-store/types.ts`. B.8 should keep one definition.
- Storage `get` returns any stored text that parses as JSON as JSON, so plain text "123" written by app server code reads back as a number.
- Storage `list` fetches values to return only keys.
- `unavailableAppStore` in `compose.ts` rejects with a plain Error until B.8 wires the store.
- Member calls record no `connector.call` event.
- Any `published` version can be called by members, not only the current one. B.6 needs the current-version rule for live links.
- A test for a `retry` decline from `refresh`, and a two-connector order test in the db test, are missing.

## Ideas beyond the scope

- Argument limits from the version's grants (PRD section 4, "argument limits") are not enforced.
- Pass an MCP `isError` result through a stricter filter before B.6 sends it to a link holder.

## Contracts other tasks rely on

- `credentials.resolveUser({ connectorId, userId, workspaceId })`: the person's own credential, no agent, no fallback.
- `callMcpTool` in `connectors/mcp.ts`.
- `createToolRunner({ credentials, db, fetch }).run({ agentId, arguments, toolKey, userId, workspaceId })` in `artifacts/calls.ts` is the entry B.6 calls with `userId: granted_by` after its own call-time checks. `ArtifactToolPort` is what B.2's `AppHost` takes. Errors are `ArtifactCallError` with code `failed`, `needs_auth`, `not_granted` or `too_large`.
- `Services.artifactCalls`, `Services.artifactStorage` and `Infra.appStore` (an `AppStorePort`) in `compose.ts`.
- tRPC: `artifacts.callTool`, and `artifacts.storageGet`, `storageSet`, `storageDelete`, `storageList`.

## Steps for Dom

None. B.8 wires `Infra.appStore` to B.3's `appStorePort(env.APP_STORE)`.
