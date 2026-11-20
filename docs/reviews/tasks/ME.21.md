# ME.21 review

The server never hands a private memory file to a working copy.

## Verdict per round

- Round 1, commit 0dab6294: clean. No must-fix. The reviewer put the old route file back and both new tests failed, so they catch the leak.

## What changed

List, stat and read on `/api/runs/:id/library` and `/api/session/library` leave out and refuse `agents/*/memory/private` and everything in it. The check runs on the normalised path, so `memory/./private`, `//` and `..` spellings get nothing. A list of `memory/` drops the `private` folder entry. The same run still has its private notes in its launch context. `isPrivateMemoryPath` sits in `library/memory-paths.ts`, and it covers `teams/*/memory/private` too, like `privateMemoryOwner` does. ME.15's Dom step now says only to upgrade machines that already hold a copy.

## Nits left

- `apps/web/src/server/routes/run-library.ts` header still says the file only authenticates and maps refusals. It now also refuses private memory paths.
- The spelling test covers the run prefix only, and has no trailing-slash case. Both prefixes share the handlers.
- An old daemon that edited a private file locally now gets 404 on stat, then a 403 on write, so that path shows as failed on each sync until the machine is upgraded. Log noise only.

## Ideas beyond the scope

- `apps/web/src/server/linux-vm/vm-library-sync.ts` keeps its own `PRIVATE_MEMORY` regex (agents only). It could use `isPrivateMemoryPath`.

## Steps for Dom

None. Upgrading machines that already hold a private file is in ME.15's steps.
