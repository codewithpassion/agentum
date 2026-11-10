/**
 * Links between the library and run files (F.4). The two stores stay apart and
 * a link copies bytes, so a run's inputs never change under it and a saved
 * output is not touched by later library edits.
 *
 * `attach` copies a library file into a new `files` row (source `library`) that
 * a run can list as input. `save` copies a file's bytes into the library, and
 * the library service records the `library.write` event. Both are for people:
 * agents reach the library through the `bash` tool.
 */

import type { FileRecord, FilesService } from "./files.ts";
import { requireUser } from "./guards.ts";
import type { LibraryEntry, LibraryService } from "./library.ts";
import type { Principal } from "./workspaces.ts";

const LAST_SEGMENT = /[^/]*$/;

export const createLibraryLinksService = ({
  files,
  library,
}: {
  files: Pick<FilesService, "download" | "upload">;
  library: Pick<LibraryService, "read" | "write">;
}) => {
  const attach = async (
    principal: Principal,
    path: string
  ): Promise<FileRecord> => {
    const user = requireUser(principal, "library.attach");
    const { bytes, entry } = await library.read(user, path);
    return files.upload(user, {
      body: new Blob([bytes.slice().buffer]),
      mime: null,
      name: LAST_SEGMENT.exec(entry.path)?.[0] ?? entry.path,
      source: "library",
    });
  };

  const save = async (
    principal: Principal,
    fileId: string,
    path: string
  ): Promise<LibraryEntry> => {
    const user = requireUser(principal, "library.save");
    const { body } = await files.download(user, fileId);
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    return library.write(user, path, bytes);
  };

  return { attach, save };
};

export type LibraryLinksService = ReturnType<typeof createLibraryLinksService>;
