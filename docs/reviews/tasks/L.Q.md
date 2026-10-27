# L.Q — atomic artifact workspace quota

Implemented on branch `t3/atomic-artifact-quota` for the Medium quota race in L.4a. No schema, migrations, task files, comments/access logic, or deployment changes.

The existing preflight remains a UX optimization. Enforcement now happens inside the same `atomic` DB write that publishes the version and file rows. `artifactQuotaGuard` in `packages/db/src/artifacts.ts:423` groups the workspace's complete retained file history by SHA-256, sums one size per hash, and conditionally updates the candidate version. At or below quota it preserves `total_bytes`; above quota it assigns NULL, deliberately failing the existing `artifact_versions.total_bytes` NOT NULL constraint. SQLite/D1 serialize these write transactions, so a later publisher sees the earlier committed publisher plus its own newly inserted files. A rejected statement aborts the entire batch/transaction. There is no read/decision gap, application lock, new table, or persistent reservation to leak.

The guard must follow every candidate file insert and target the version inserted in the same transaction. It counts historical, proposed, published and soft-deleted artifact files just as existing storage accounting does. Grouping uses the maximum size for each hash, conservatively counting a single blob even if legacy metadata disagrees. Actual writers compute hashes and sizes from the same immutable bytes.

Precise insertion points:

- Static: `packages/services/src/artifacts/service.ts:653`, the final statement returned by `versionStatements`, after all D1-sized file insert chunks. This covers `create`, `update` (including proposals), and `restore`; each caller includes these statements in its existing publication transaction. `commit` at line 682 translates the assertion failure.
- Live: `packages/services/src/live-artifacts/service.ts:436`, the final statement in `persist`'s existing atomic statement list, after version/files, pointer/revision and events. The existing catch at line 441 translates quota failure before handling version conflicts. This covers document creation/conversion, checkpoint and restore through their shared persistence path. These helper imports/destructuring, statement insertion and error translation are the only live-service changes.
- Shared storage: `packages/services/src/artifacts/blob-writer.ts` supplies the configured quota statement and recognizes the exact NOT NULL constraint through D1/Drizzle error causes, returning `ServiceError("invalid", "The workspace's artifact storage is full (1 GB)")`. Unrelated DB failures and unique-version conflict handling retain their existing behavior.

Regression evidence in `packages/services/src/artifacts/quota.test.ts` uses real migrated SQLite and the production atomic adapter. A manifest-write gate pauses one publisher after preflight; an independent competing service instance commits before the paused publisher resumes. Tests cover static/live creation, live/live creation, static update/live checkpoint, live/live checkpoints on different artifacts, and live restore/live checkpoint. Every loser receives the quota error; complete artifact, version, file and event row snapshots remain identical to those immediately after the winner, including current-version pointers and live revision. The surviving workspace total stays within quota.

Competing identical live content succeeds twice without additional accounting, including matching content at different paths and in later static versions. Static restore succeeds at exactly quota while retaining the same distinct-byte total. Wrapped D1-style assertion errors translate correctly and unrelated failures are not relabelled. Fixture metadata supplies the near-1-GB ballast; actual document/blob allocations remain tiny.

As a negative control, temporarily removing both guard insertions allowed all five stale-preflight losers to commit and failed all five race assertions. Both insertions were restored before final validation. The final focused command `bun run --cwd packages/services test src/artifacts/quota.test.ts src/live-artifacts src/artifacts/service` passed: **126 pass, 0 fail** (including eight quota regressions).

Immutable blobs and manifests can remain unreferenced after a failed DB publication, as before; this guard enforces the quota of referenced, deduplicated blobs. Blob cleanup is separate. Room restore still precedes DB persistence; a failed restore publication needs the already-documented room reconciliation path. This change rolls back its DB publication, not the external room operation.

Final validation completed successfully on the implementation:

- `bun install --frozen-lockfile`: passed. Missing ignored `apps/web/.env` was copied from `.env.example` without overwriting an existing file.
- Focused services tests: **126 pass, 0 fail**.
- `bun run check`: exit 0, **9/9 tasks**, boundary lint clean.
- `bun run test`: exit 0, **9/9 workspace tasks** plus **284 root script tests**; services **3,070 pass**, web **3,253 pass, 1 existing skip**, no failures.
- `bun run build`: exit 0, **2/2 tasks**; existing Vite CSS sourcemap warning only.
- `git diff --check`: clean.

All commands were allowed to finish. No push, PR or deploy was performed.

## Independent review — 2026-10-27

Reviewed merged implementation `2939770acc67000d31b741a0afefafcfee5f87c3` in the assigned worktree. **Verdict: accepted; no quota defects found.** No product or task files were edited.

- Both production insert sites create the target version with the same workspace and version ID before inserting its files and running the guard. Static `versionStatements` covers create, update (including proposed app versions), and restore; live `persist` covers creation, conversion, checkpoint, and restore. Promotion of a proposal does not insert additional file rows. The guard's update would affect no rows for a missing or mismatched target, so this ordering and matching scope are essential; both current callers satisfy them.
- The guard sums the maximum size per SHA-256 over all retained file rows in the target workspace, including proposals and soft-deleted artifacts, and includes its own inserted rows. Equal hashes count once; the maximum handles inconsistent legacy sizes conservatively. The preflight's distinct `(hash, size)` accounting can be more conservative for inconsistent metadata; normal content-addressed writers generate matching sizes. The guard accepts exactly the limit.
- SQLite's adapter executes statements synchronously in one transaction and rolls back on the NOT NULL exception. D1's adapter uses a single batch; [Cloudflare's batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/) states a failed statement rolls back the sequence, and its [D1 FAQ](https://developers.cloudflare.com/d1/reference/faq/) states each database processes queries one at a time. Thus competing write batches serialize, and the later guard sees the earlier commit and its own inserts. This is documentation and code analysis, not a deployed D1 concurrency test.
- The error translation matches the specific `artifact_versions.total_bytes` NOT NULL text through wrapped error causes; other constraints are not intentionally relabeled. Inserts supply a non-null total, making the deliberate guard the source of that constraint in these publication paths. Unique version insertion precedes the guard, and the existing unique-violation conflict handling remains in both catches. Existing static and live concurrent-version tests pass.
- Inspected the five regression gates and snapshots: each pauses after preflight at manifest write, commits an independent competing service operation, then checks the loser's quota error and unchanged artifact/version/file/event rows. The reported negative control removing both guards would directly exercise those assertions; it was not independently rerun. These tests model stale decisions with sequential transactions on one SQLite connection, not simultaneous database connections or D1 error wrapping. The wrapped D1 error test is synthetic.
- Orphan blob cleanup and reconciliation after a room restore that fails DB persistence remain separate concerns, as specified in the task.

Validation: `bun install --frozen-lockfile` passed. After installation, `bun run --cwd packages/services test src/artifacts/quota.test.ts src/live-artifacts src/artifacts/service` passed **126 tests, 0 failures**. The initial attempt before installation failed to resolve workspace packages. Full root checks and build were not rerun for this report-only review.
