# F.1 review

## Verdicts

- Round 1 (c4473b2): must-fix. The path test filtered out `w2/` keys before asserting that only `w1/library/` keys were touched, so it could not catch a cross-workspace read.
- Round 2 (132c4f7): clean. The test now resets the touched-key list after setup and checks every key. The Skills row in the architecture doc is in the future tense.

## Nits left

- `libraryBlobs` in `Infra` is optional and falls back to an in-memory store, so the test fake ships in the Worker bundle. Making it required means editing about 20 test files that build `Infra`.
- `stat("")` reports the root as updated by a made-up `system` user, dated at the epoch.
- `mkdir` re-reads its own insert and throws `not_found` on a case that cannot happen.
- `remove` uses `row.workspaceId` where the rest of the file uses `member.workspaceId`.
- The 1 GB check runs before the R2 put, so concurrent writes can pass together and slightly exceed it.
- Two concurrent writes without `ifEtag` can land in R2 in one order and in D1 in the other. The row's etag is stale until the next write, and a client that took it from `stat` gets a false `conflict`.
- `move` copies a folder file by file, a get and a put each. A very large folder could reach Worker time or subrequest limits.
- `list` has no paging.

## Ideas beyond the scope

- A Durable Object per workspace to serialise writes, which also fixes the concurrent-writer and quota races.
- A `library.move` event type, so one move is one event instead of a delete plus a write.
- Content types on stored objects, once the browse page (F.3) needs to serve them.

## Notes on shape

- The service takes `{ atomic, blobs, clock, db, events }`, not only `{ db, blobs, clock }`, because the row and event land through `atomic`.
- The workspace comes from the principal, so another workspace's paths are `not_found`. Machine, trigger and system principals get `forbidden`. A read-only API key or OAuth client reads but cannot write.
- A move writes a `library.delete` event for the source and a `library.write` event for the destination. A recursive remove writes one `library.delete` for the folder with the total size.
- `library_entries` has a `parent` column beyond the spec, so listing a folder is one indexed query. D1 binds 100 parameters per statement, so inserts go in chunks of 10 rows.
- Migration `0015_sweet_marten_broadcloak.sql` adds the table.

## Steps for Dom

None. The `FILES` bucket and the D1 database already exist. Apply the migration with the usual `wrangler d1 migrations apply DB --remote` on deploy.
