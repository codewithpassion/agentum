import type { LibraryService } from "@repo/services/library";
import type { Principal } from "@repo/services/workspaces";
import type { LibraryOps } from "../library-bash/library-fs.ts";

/** The library service with one principal bound, which is all the library filesystems see of who is asking. */
export const bindLibraryOps = (
  library: LibraryService,
  principal: Principal
): LibraryOps => ({
  list: (dir) => library.list(principal, dir),
  mkdir: (path) => library.mkdir(principal, path),
  move: (from, to) => library.move(principal, from, to),
  read: (path) => library.read(principal, path),
  remove: (path, options) => library.remove(principal, path, options),
  stat: (path) => library.stat(principal, path),
  write: (path, bytes, options) =>
    library.write(principal, path, bytes, options),
});
