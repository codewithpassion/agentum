// What the Worker and the daemon agree on for a run's view of the workspace
// library (W.8). Every route is `/api/runs/:id/library/...` and takes the run
// token. A path is a library path with no leading slash. The routes:
//
//   GET    list?path=      -> { entries }
//   GET    stat?path=      -> { entry }
//   GET    file?path=      -> the bytes, with the etag in `X-Library-Etag`
//   PUT    file?path=      -> { etag }; `X-Library-If-Etag` keeps the file only
//                             if it still has that etag, else 409
//   DELETE file?path=      -> {}
//   POST   conflicts       -> {}; body is `libraryConflictRequestSchema`

import { z } from "zod";

/** The header that carries a file's etag on a read. */
export const LIBRARY_ETAG_HEADER = "X-Library-Etag";

/** The request header that makes a write conditional on the file's etag. */
export const LIBRARY_IF_ETAG_HEADER = "X-Library-If-Etag";

export const libraryEntrySchema = z.strictObject({
  // Null for a folder.
  etag: z.string().nullable(),
  kind: z.enum(["dir", "file"]),
  path: z.string(),
  size: z.int().nonnegative(),
});
export type LibraryEntryWire = z.infer<typeof libraryEntrySchema>;

export const libraryListResponseSchema = z.strictObject({
  entries: z.array(libraryEntrySchema),
});

export const libraryStatResponseSchema = z.strictObject({
  entry: libraryEntrySchema,
});

export const libraryWriteResponseSchema = z.strictObject({
  etag: z.string(),
});

/** A write that lost to a newer library file: the bytes went to `conflictPath`. */
export const libraryConflictRequestSchema = z.strictObject({
  conflictPath: z.string().min(1),
  path: z.string().min(1),
});
export type LibraryConflictRequest = z.infer<
  typeof libraryConflictRequestSchema
>;
