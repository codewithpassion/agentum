import { LIBRARY_FILE_MAX_BYTES } from "@repo/db/shared";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type TreeRow,
  treeRows,
  uploadPath,
  validNewFilePath,
} from "#/components/agent/profile/sheets/skill-tree.ts";
import {
  type FilePanelIo,
  LibraryFilePanel,
} from "#/components/library/library-file-panel";
import { errorMessage } from "#/components/library/library-logic.ts";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type {
  LibraryFileView,
  SkillVersionFile,
} from "#/integrations/trpc/types";
import { bytesToBase64 } from "#/lib/library-content.ts";
import {
  type Change,
  type ChangeKind,
  changes,
  type Draft,
  type DraftFile,
  draftFileSize,
  emptyDraft,
  stageDelete,
  stageWrite,
  toCommitInput,
  treePaths,
} from "./skill-draft.ts";

const SKILL_FILE = "SKILL.md";

const STAGE_LABELS = {
  save: "Stage change",
  saved: "Staged. Commit to save it.",
};

type LibraryEntry = LibraryFileView["entry"];

const fileEntry = (path: string, size: number): LibraryEntry => ({
  etag: null,
  kind: "file",
  mtime: new Date().toISOString(),
  path,
  size,
  updatedBy: { id: "", kind: "user" },
});

const ignoreChange = () => undefined;

const rowClass = (active: boolean) =>
  `w-full truncate rounded-md py-1 pr-2 text-left text-sm hover:bg-muted ${
    active ? "bg-muted font-medium text-foreground" : "text-muted-foreground"
  }`;

interface StagedFileTarget {
  base: readonly SkillVersionFile[];
  baseVersion: number;
  currentDraft: () => Draft;
  path: string;
  skillId: string;
  stage: (update: (draft: Draft) => Draft) => void;
}

/**
 * The panel's io for one file. It reads the draft when it runs, not when it is
 * built, so the object changes only when the file or the base changes.
 */
const stagedFileIo = ({
  base,
  baseVersion,
  currentDraft,
  path,
  skillId,
  stage,
}: StagedFileTarget): FilePanelIo => {
  const basePaths = new Set(base.map((file) => file.path));
  return {
    read: async () => {
      const staged = currentDraft().writes.get(path);
      if (staged !== undefined) {
        return {
          entry: fileEntry(path, draftFileSize(staged)),
          text: staged.encoding === "text" ? staged.data : null,
        };
      }
      const shown = await getTrpc().skillStore.readFile.query({
        path,
        skillId,
        version: baseVersion,
      });
      return {
        entry: fileEntry(path, shown.size),
        text: shown.text,
      };
    },
    remove: () => {
      stage((draft) => stageDelete(draft, path, basePaths));
      return Promise.resolve();
    },
    write: (text) => {
      const file: DraftFile = { data: text, encoding: "text" };
      stage((draft) => stageWrite(draft, path, file));
      return Promise.resolve(fileEntry(path, draftFileSize(file)));
    },
  };
};

function StagedFileEditor({
  onClosed,
  ...target
}: StagedFileTarget & { onClosed: () => void }) {
  const { base, baseVersion, currentDraft, path, skillId, stage } = target;
  const io = useMemo(
    () =>
      stagedFileIo({ base, baseVersion, currentDraft, path, skillId, stage }),
    [base, baseVersion, currentDraft, path, skillId, stage]
  );
  return (
    <LibraryFilePanel
      io={io}
      labels={STAGE_LABELS}
      onChanged={ignoreChange}
      onClosed={onClosed}
      path={path}
    />
  );
}

function TreeRowButton({
  active,
  change,
  onPick,
  row,
}: {
  active: boolean;
  change: ChangeKind | undefined;
  onPick: (row: TreeRow) => void;
  row: TreeRow;
}) {
  const pick = useCallback(() => onPick(row), [row, onPick]);
  const style = { paddingLeft: `${row.depth * 16 + 8}px` };
  if (row.kind === "dir") {
    return (
      <li>
        <button
          aria-pressed={active}
          className={rowClass(active)}
          data-path={row.path}
          data-testid="skill-dir-row"
          onClick={pick}
          style={style}
          type="button"
        >
          {row.name}/
        </button>
      </li>
    );
  }
  return (
    <li>
      <button
        aria-pressed={active}
        className={rowClass(active)}
        data-path={row.path}
        data-testid="skill-file-row"
        onClick={pick}
        style={style}
        type="button"
      >
        <span className={change === "deleted" ? "line-through" : undefined}>
          {row.name}
        </span>
        {change === undefined ? null : (
          <span className="ml-2 text-muted-foreground text-xs">{change}</span>
        )}
      </button>
    </li>
  );
}

function CommitBar({
  changeList,
  commitError,
  committed,
  committing,
  message,
  onCommit,
  onDiscard,
  onMessage,
}: {
  changeList: readonly Change[];
  commitError: string | undefined;
  committed: number | undefined;
  committing: boolean;
  message: string;
  onCommit: () => void;
  onDiscard: () => void;
  onMessage: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const messageId = useId();
  const hasChanges = changeList.length > 0;
  const canCommit = hasChanges && message.trim() !== "" && !committing;
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-3">
      {hasChanges ? (
        <ul aria-label="Staged changes" className="flex flex-col gap-1 text-sm">
          {changeList.map((change) => (
            <li
              data-testid="skill-draft-change"
              key={`${change.kind}:${change.path}`}
            >
              <span className="text-muted-foreground">{change.kind}</span>{" "}
              {change.path}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">No changes staged.</p>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={messageId}>Commit message</Label>
        <Input
          data-testid="skill-commit-message"
          id={messageId}
          onChange={onMessage}
          placeholder="Describe the change"
          value={message}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="skill-commit"
          disabled={!canCommit}
          onClick={onCommit}
          type="button"
        >
          Commit
        </Button>
        <Button
          data-testid="skill-discard"
          disabled={!hasChanges || committing}
          onClick={onDiscard}
          type="button"
          variant="outline"
        >
          Discard changes
        </Button>
      </div>
      {committed === undefined ? null : (
        <p className="text-sm" data-testid="skill-committed">
          {`Committed as version ${committed}.`}
        </p>
      )}
      {commitError === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {commitError}
        </p>
      )}
    </section>
  );
}

export interface SkillEditorProps {
  baseVersion: number;
  onCommitted: () => void;
  skillId: string;
}

/** The file tree and editor of one skill version. Edits are staged, then saved as one commit. */
export function SkillEditor({
  baseVersion,
  onCommitted,
  skillId,
}: SkillEditorProps) {
  const viewKey = `${skillId}\n${baseVersion}`;
  const [base, setBase] = useState<SkillVersionFile[] | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [selected, setSelected] = useState<string | undefined>();
  const [uploadDir, setUploadDir] = useState("");
  const [newPath, setNewPath] = useState("");
  const [addError, setAddError] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | undefined>();
  const [committed, setCommitted] = useState<number | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);
  // The view (skill and base version) on screen. Null after unmount, so a late response is dropped.
  const shownView = useRef<string | null>(null);
  // The draft as of the last render, read by the file panel outside of render.
  const draftRef = useRef(draft);
  // Set during render, not in an effect: the file panel of a freshly added file reads it in its own mount effect, which runs first.
  draftRef.current = draft;

  const currentDraft = useCallback(() => draftRef.current, []);

  // A new base version starts a fresh view: the staged edits were made against the old tree.
  useEffect(() => {
    shownView.current = viewKey;
    setBase(undefined);
    setLoadError(undefined);
    setDraft(emptyDraft());
    setSelected(undefined);
    setUploadDir("");
    getTrpc()
      .skillStore.show.query({ skillId, version: baseVersion })
      .then(
        (shown) => {
          if (shownView.current !== viewKey) {
            return;
          }
          setBase(shown.files);
          if (shown.files.some((file) => file.path === SKILL_FILE)) {
            setSelected(SKILL_FILE);
          }
        },
        (cause: unknown) => {
          if (shownView.current === viewKey) {
            setLoadError(errorMessage(cause));
          }
        }
      );
    return () => {
      shownView.current = null;
    };
  }, [baseVersion, skillId, viewKey]);

  const basePaths = useMemo(
    () => new Set((base ?? []).map((file) => file.path)),
    [base]
  );
  const livePaths = useMemo(
    () => treePaths(basePaths, draft),
    [basePaths, draft]
  );
  // Deleted files stay in the tree, struck through, so they can be seen.
  const rows = useMemo(
    () => treeRows([...livePaths, ...draft.deletes]),
    [livePaths, draft.deletes]
  );
  const changeList = useMemo(
    () => changes(basePaths, draft),
    [basePaths, draft]
  );
  const changeKinds = useMemo(
    () =>
      new Map(
        changeList.map((change): [string, ChangeKind] => [
          change.path,
          change.kind,
        ])
      ),
    [changeList]
  );

  const pickRow = useCallback((row: TreeRow) => {
    if (row.kind === "dir") {
      setUploadDir(row.path);
    } else {
      setSelected(row.path);
    }
  }, []);

  const pickRoot = useCallback(() => setUploadDir(""), []);

  const closeFile = useCallback(() => setSelected(undefined), []);

  const changeNewPath = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setNewPath(event.target.value),
    []
  );

  const changeMessage = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setMessage(event.target.value),
    []
  );

  const addFile = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const path = newPath.trim();
      const problem = validNewFilePath(path);
      if (problem !== null) {
        setAddError(problem);
        return;
      }
      if (livePaths.includes(path)) {
        setAddError("A file with this path already exists");
        return;
      }
      setAddError(undefined);
      setDraft((current) =>
        stageWrite(current, path, { data: "", encoding: "text" })
      );
      setNewPath("");
      setSelected(path);
    },
    [livePaths, newPath]
  );

  const openFilePicker = useCallback(() => fileInput.current?.click(), []);

  const uploadChosen = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const chosen = Array.from(input.files ?? []);
      if (chosen.length === 0) {
        return;
      }
      const dir = uploadDir;
      const view = viewKey;
      const problems: string[] = [];
      const staged: [string, DraftFile][] = [];
      setUploadError(undefined);
      setUploading(true);
      try {
        // Files are read one after the other so the staged order matches the pick.
        for (const file of chosen) {
          if (file.size > LIBRARY_FILE_MAX_BYTES) {
            problems.push(`${file.name} is larger than 10 MB and was skipped.`);
            continue;
          }
          // biome-ignore lint/performance/noAwaitInLoops: sequential by design, see above
          const bytes = new Uint8Array(await file.arrayBuffer());
          staged.push([
            uploadPath(dir, file.name),
            { data: bytesToBase64(bytes), encoding: "base64" },
          ]);
        }
      } catch (cause) {
        problems.push(errorMessage(cause));
      } finally {
        input.value = "";
        setUploading(false);
        setUploadError(problems.length === 0 ? undefined : problems.join(" "));
      }
      if (shownView.current === view) {
        setDraft((current) =>
          staged.reduce(
            (next, [path, file]) => stageWrite(next, path, file),
            current
          )
        );
      }
    },
    [uploadDir, viewKey]
  );

  const discard = useCallback(() => {
    setDraft(emptyDraft());
    setSelected(undefined);
    setCommitError(undefined);
    setCommitted(undefined);
  }, []);

  const commit = useCallback(async () => {
    const trimmed = message.trim();
    if (trimmed === "" || changeList.length === 0 || committing) {
      return;
    }
    const view = viewKey;
    setCommitting(true);
    setCommitError(undefined);
    setCommitted(undefined);
    try {
      const version = await getTrpc().skillStore.commit.mutate(
        toCommitInput(skillId, baseVersion, trimmed, draft)
      );
      if (shownView.current !== view) {
        return;
      }
      setDraft(emptyDraft());
      setMessage("");
      setCommitted(version.number);
      onCommitted();
    } catch (cause) {
      if (shownView.current === view) {
        setCommitError(errorMessage(cause));
      }
    } finally {
      setCommitting(false);
    }
  }, [
    baseVersion,
    changeList.length,
    committing,
    draft,
    message,
    onCommitted,
    skillId,
    viewKey,
  ]);

  if (base === undefined) {
    return loadError === undefined ? (
      <p className="text-muted-foreground text-sm">Loading files.</p>
    ) : (
      <p className="text-destructive text-sm" role="alert">
        {loadError}
      </p>
    );
  }

  const uploadLabel = uploadDir === "" ? "skill root" : uploadDir;

  return (
    <section className="flex flex-col gap-4">
      <ul aria-label="Skill files" className="flex flex-col gap-0.5">
        <li>
          <button
            aria-pressed={uploadDir === ""}
            className={rowClass(uploadDir === "")}
            data-testid="skill-root-row"
            onClick={pickRoot}
            style={{ paddingLeft: "8px" }}
            type="button"
          >
            Skill root
          </button>
        </li>
        {rows.map((row) => (
          <TreeRowButton
            active={
              row.kind === "dir"
                ? uploadDir === row.path
                : selected === row.path
            }
            change={row.kind === "file" ? changeKinds.get(row.path) : undefined}
            key={`${row.kind}:${row.path}`}
            onPick={pickRow}
            row={row}
          />
        ))}
      </ul>
      <form className="flex flex-wrap items-center gap-2" onSubmit={addFile}>
        <Input
          aria-label="New file path"
          className="max-w-sm"
          data-testid="skill-new-file-path"
          onChange={changeNewPath}
          placeholder="scripts/hello.ts"
          value={newPath}
        />
        <Button data-testid="skill-add-file" type="submit" variant="outline">
          Add file
        </Button>
      </form>
      {addError === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {addError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={uploading}
          onClick={openFilePicker}
          type="button"
          variant="outline"
        >
          {uploading ? "Uploading..." : "Upload"}
        </Button>
        <input
          className="hidden"
          data-testid="skill-upload-input"
          hidden
          multiple
          onChange={uploadChosen}
          ref={fileInput}
          type="file"
        />
        <p className="text-muted-foreground text-sm">Upload to {uploadLabel}</p>
      </div>
      {uploadError === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {uploadError}
        </p>
      )}
      <CommitBar
        changeList={changeList}
        commitError={commitError}
        committed={committed}
        committing={committing}
        message={message}
        onCommit={commit}
        onDiscard={discard}
        onMessage={changeMessage}
      />
      {selected === undefined ? null : (
        <StagedFileEditor
          base={base}
          baseVersion={baseVersion}
          currentDraft={currentDraft}
          key={selected}
          onClosed={closeFile}
          path={selected}
          skillId={skillId}
          stage={setDraft}
        />
      )}
    </section>
  );
}
