# F.3 review

## Verdicts

- Round 1 (9f124fb): clean. No must-fix findings.

## Checks

`bun run check`, `bun run test` and `bun run build` pass, and `dist/client` has no `drizzle`. In local dev, as the dev user: upload a file, open it, edit and save it, see a conflict ("This file changed since you opened it.") after another write changed it, delete it with the confirm, create a folder, upload into it, and delete the folder with its content. The saved text was read back through `GET /api/library/download`.

The task's last step, seeing the saved edit through the F.2 `bash` tool (`cat`), is not done here. F.2 was not on `main` when this branch was built.

## Nits left

- `library.read` loads the whole object (up to 10 MB) even when it is over 1 MB and the text is dropped. A size check on the entry first would skip the R2 read.
- The router decodes and encodes bytes itself (`decodeLibraryText`, `base64ToBytes`, `textToBytes`). That is transport work, but it is more than "schema plus one service call".
- `library-toolbar.tsx` repeats the 10 MB cap instead of importing `LIBRARY_FILE_MAX_BYTES` from `@repo/db/shared`.
- An upload overwrites a file with the same name without asking, and a batch with several failures shows only the last error.
- The textarea returns LF line endings, so saving a CRLF file converts it. The text decoder drops a leading BOM, so a save drops it.
- Deleting the open file, or its folder, from the list leaves the file panel open on a file that is gone.
- A stale `?dir=` for a folder that no longer exists makes the loader throw `not_found`, and no route has an `errorComponent`, so the user sees the default error page.
- The header comment of `routes/runtime.ts` lists only "machines, files, Slack".

## Ideas beyond the scope

- A size-aware `read` in the library service (`stat` first, bytes only under the text limit), which also helps the F.2 `bash` tool.
- An `errorComponent` on the app layout route, for every page's loader errors.
- A confirm before an upload replaces a file, using the etag.

## For Dom

Nothing needs your accounts or dashboards. The page works in local dev and uses the existing `FILES` bucket binding.
