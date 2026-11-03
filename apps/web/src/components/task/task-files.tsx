import { Link } from "@tanstack/react-router";
import {
  baseName,
  downloadUrl,
  formatSize,
  parentDir,
} from "#/components/library/library-logic.ts";
import type { RouterOutputs } from "#/integrations/trpc/types";
import {
  fileEntries,
  fileTime,
  outsideTag,
  relativeToFolder,
} from "./files-logic.ts";

export type TaskFilesView = RouterOutputs["tasks"]["files"];

const TAG = "self-start rounded px-1.5 py-px font-mono text-[11px]";
const NEW_TAG = `${TAG} bg-success/15 text-success`;
const EDIT_TAG = `${TAG} bg-info/15 text-info`;
const CONFLICT_TAG = `${TAG} bg-warning/15 text-warning`;
const ROW = "grid grid-cols-[92px_1fr] gap-2.5 border-t py-1.5 text-sm";
const LINK = "underline underline-offset-2";

/** A path in the library, opened in the library page next to its folder. */
function LibraryLink({ children, path }: { children: string; path: string }) {
  const dir = parentDir(path);
  return (
    <Link
      className={LINK}
      search={{ dir: dir === "" ? undefined : dir, file: path }}
      to="/library"
    >
      {children}
    </Link>
  );
}

/** The task folder's files, what the task edited outside it, and its open conflicts. */
export function TaskFilesList({ files }: { files: TaskFilesView }) {
  const entries = fileEntries(files.entries);
  const { conflicts, folder, outside } = files;
  const empty =
    entries.length === 0 && outside.length === 0 && conflicts.length === 0;
  return (
    <>
      <div className="break-all font-mono text-muted-foreground text-xs">
        library/{folder}/
      </div>
      {empty ? (
        <p className="text-muted-foreground text-sm">
          Nothing in the task folder yet.
        </p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <li
              className={ROW}
              data-testid="task-file"
              key={`entry:${entry.path}`}
            >
              <span className={NEW_TAG}>in folder</span>
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <b className="min-w-0 break-all font-medium">
                  <LibraryLink path={entry.path}>
                    {relativeToFolder(entry.path, folder)}
                  </LibraryLink>
                </b>
                <span className="text-muted-foreground text-xs">
                  {formatSize(entry.size)} · {fileTime(entry.mtime)}
                </span>
                <a
                  className={`${LINK} text-xs`}
                  download={baseName(entry.path)}
                  href={downloadUrl(entry.path)}
                >
                  Download
                </a>
              </span>
            </li>
          ))}
          {outside.map((edit) => (
            <li
              className={ROW}
              data-testid="task-file-outside"
              key={`outside:${edit.path}`}
            >
              <span className={EDIT_TAG}>
                {outsideTag(edit.op, edit.version)}
              </span>
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <b className="min-w-0 break-all font-medium">
                  {edit.op === "delete" ? (
                    edit.path
                  ) : (
                    <LibraryLink path={edit.path}>{edit.path}</LibraryLink>
                  )}
                </b>
                <span className="text-muted-foreground text-xs">
                  outside the task folder · {fileTime(edit.createdAt)}
                </span>
              </span>
            </li>
          ))}
          {conflicts.map((conflict) => (
            <li
              className={ROW}
              data-testid="task-file-conflict"
              key={`conflict:${conflict.id}`}
            >
              <span className={CONFLICT_TAG}>conflict</span>
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <b className="min-w-0 break-all font-medium">{conflict.path}</b>
                <span className="text-muted-foreground text-xs">
                  changed in the library while the agent edited it. Both
                  versions kept.
                </span>
                <LibraryLink path={conflict.conflictPath}>Compare</LibraryLink>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Link
          className="inline-block pointer-coarse:inline-flex pointer-coarse:min-h-10 pointer-coarse:items-center rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
          search={{ dir: folder }}
          to="/library"
        >
          Open in library
        </Link>
      </div>
    </>
  );
}
