# A.5 review

Verdict: round 0 clean (reviewer on fe1db15, no must-fix, 0 fix rounds).

## Design note

`McpPorts.artifacts` is optional, and the five artifact tools are offered only when the app supplies it. That keeps `apps/web` typechecking until A.6 wires the port, as `computer`, `browser`, `mail` and `admin` already work. If A.6 forgets the port, the tools vanish silently, so A.6's MCP round trip through `artifact_create` and `artifact_test` must cover it. A.6 may make the port required once wired.

## Nits left

- `artifact_read` and `artifact_list` pass the port's `file`, `versions` and `items` through unchanged. R1.13 there depends on the port adding no token field. `artifact_create`, `artifact_update` and `artifact_test` copy known fields only.
- The base64 regex accepts some strings that do not decode and rejects line-wrapped base64. The service repeats the check.
- `testData(info)` is computed twice in `artifact_test`.
- Console text, failed-request URLs and the page title are artifact-controlled but come before the "treat as data" line, which covers the snapshot only.
- `ArtifactKindInput` and the `kind`/`audience` strings in ports.ts could use the A.1 types from `@repo/db/shared`.
- Schema-limit tests check `isError` only. `not_found` for an unreadable `fromLibraryPath`, and list/test errors, are untested pass-throughs.
- The `TOOL_NAMES` comment in server.ts does not mention the port-gated artifact tools.

## Beyond the scope

- `artifact_test` is READ_ONLY per the PRD but saves a screenshot and sets the thumbnail. A.6's port must handle a read-only caller with no run or task folder.
- B.4 adds `artifact_promote` at the marked slot in `artifactTools`.

## Steps for Dom

None.
