---
id: CL.6
title: Offer a client update only when the release is newer
milestone: CL
size: S
status: in_progress
depends_on: [CL.1]
branch: task/CL.6-update-notice-newer-only
lane: web
executor: claude
---

The Machines page shows "Client update available" whenever a Rust machine's version differs from `latest.json`, even when the release is older. On 12 Nov it offered the 9 Nov builds (0.1.0+cc9a8ae5 on production, 0.1.0+b729f807 on staging) to Morosini, which ran the 11 Nov build 0.1.0+b4c01389. Following that notice would have been a downgrade.

Release versions are `0.1.0+<short commit>`. The `0.1.0` never changes and a commit hash has no order, so the strings can't say which build is newer. Dom chose to order builds by when they were published: every release keeps its binaries in R2 under `releases/agentum-rs/<version>/`, and R2 records an upload time for each object.

Today `latestDaemonVersion` in `apps/web/src/server/compose.ts` reads `latest.json` through `readManifest` (`apps/web/src/server/releases/store.ts`), the machines service (`packages/services/src/machines.ts`) passes the version on, and `isDaemonOutdated` in `apps/web/src/components/machines/machine-logic.ts` compares with `!==`.

## Scope
- Server side, compare the R2 upload time of the machine's version with the latest release's. Use a binary key from the existing key helpers (`fileKey` or its equivalent in `releases/manifest.ts`) and R2 `head()`, not a new path scheme. The latest release is newer only when its upload time is later.
- A machine whose version has no objects in R2 (a dev build, a hand-built binary, anything unknown) gets no notice.
- Keep the decision on the server and send the browser the result per machine (or the set of versions that are outdated), so the client doesn't need R2 access. Keep `isDaemonOutdated`'s other rules: Rust machines only, not revoked, computer-only machines by their hello version.
- One R2 `head()` per distinct version on the page, not one per machine. A bucket error still must not take the Machines page down, so it means no notice.
- Update the comment on `isDaemonOutdated` that says any different version counts.
- No change to the Rust client, the version format, `latest.json` or `publish-releases.ts`.

## Check
- Test: a 9 Nov release (latest is 0.1.0+cc9a8ae5, uploaded 9 Nov) against a machine on 0.1.0+b4c01389 (uploaded 11 Nov) shows no notice.
- Test: the reverse (machine on the 9 Nov build, latest from 11 Nov) shows the notice.
- Test: a machine on a version R2 doesn't know (e.g. 0.1.0+dev or 0.1.0+deadbeef) shows no notice.
- Test: same version, no notice. A bucket error, no notice and the page still loads.
- `bun run check && bun run test && bun run build` pass, and the drizzle grep on `apps/web/dist/client` finds nothing.
- Live on staging: both Morosini instances run 0.1.0+ee1dcb6b, which is the latest, so the Machines page shows no notice for them. `bot-ccau` is production only, so production is checked after Dom's go.

## Log
- 2026-11-12: Dom asked for it after the Machines page offered Morosini a downgrade, and picked R2 upload times over a date in the version or a semver bump. Production needs team-lead's go-ahead. Dispatched.
