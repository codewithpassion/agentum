# B.3 review: app storage

## Verdicts

Round 1, commit 9411e95: clean after 0 fix rounds. The reviewer also ran the real `AppStore`, port and rules under `wrangler dev` (workerd): numbered SQL params, prefix listing with `%`, `_` and non-ASCII, area isolation, the cap with replacement, `too_large`, `wipe`, the private `#core` field over RPC and error messages crossing RPC all worked.

## What was built

`apps/web/src/server/app-store/`: `types.ts` (`AppViewer`, `StorageArea`, `AppStorePort`, `AppStoreScope`, `AppErrorCode`), `rules.ts` (`canWrite`, `viewerKey`), `app-store-core.ts` (SQL logic over a `SqlAdapter`), `app-store.ts` (the `AppStore` Durable Object), `port.ts` (`appStorePort(namespace)` and `viewerStorage(port, artifactId, viewer)`). There is no `index.ts`, because the repo's lint bans barrel files: import from the files directly. `viewerStorage` has the `HM` storage method shapes and applies `canWrite` (throws `forbidden: ...`), so B.2 and B.5 share one rule.

## Nits left

1. `list` with a `NaN` limit or non-string prefix throws a raw error (core.ts:73). B.2 should validate what app code sends over `HM`.
2. A `limit` of 0 or below is clamped to 1 (test locks it in).
3. No runtime check that `area` is `viewer` or `shared`. A member's app sending another string stores a stray row that counts against the cap. B.2 should validate the area.
4. The port accepts an empty `viewerKey` for the `viewer` area. `viewerStorage` never sends one.
5. The cap counts key plus value bytes, not SQLite row overhead, so many tiny rows can exceed 20 MB on disk.
6. Each `set` sums `bytes` over the table, O(rows). Fine now. A running total would make it O(1).
7. A snapshot-link viewer can read the `viewer` area `l:<shareId>`. This matters only if a link can switch from live to snapshot.
8. DO tests use a fake `ctx` over bun:sqlite. B.8 could add a workerd smoke test.

## Ideas beyond scope

A per-viewer delete (`DELETE ... WHERE viewer = ?`) and an export for B.9's UI; an `updated_at` column.

## Steps for Dom

Decide the open spike question: do live-link viewers write the `viewer` area (implemented, `canWrite`) or nothing? Then B.8 adds the `APP_STORE` binding and the `v7` migration (`new_sqlite_classes: ["AppStore"]`) and exports `AppStore` from `server.ts`.
