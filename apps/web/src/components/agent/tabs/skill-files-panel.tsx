import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type FilePanelIo,
  LibraryFilePanel,
} from "#/components/library/library-file-panel";
import {
  downloadUrl,
  errorMessage,
} from "#/components/library/library-logic.ts";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { SkillEntry, SkillTreeFile } from "#/integrations/trpc/types";
import { bytesToBase64 } from "#/lib/library-content.ts";
import {
  type TreeRow,
  treeRows,
  uploadPath,
  validNewFilePath,
} from "./skill-tree.ts";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const SKILL_FILE = "SKILL.md";

type Scope = SkillEntry["scope"];

interface SkillTarget {
  agentId: string;
  scope: Scope;
  skill: string;
}

const skillFileIo = (target: SkillTarget, path: string): FilePanelIo => {
  const folder = target.scope === "shared" ? "_shared" : target.agentId;
  return {
    downloadHref: downloadUrl(`skills/${folder}/${target.skill}/${path}`),
    read: () => getTrpc().skills.readFile.query({ ...target, path }),
    remove: async () => {
      await getTrpc().skills.removeFile.mutate({ ...target, path });
    },
    write: (data, ifEtag) =>
      getTrpc().skills.writeFile.mutate({
        ...target,
        data,
        encoding: "text",
        ifEtag,
        path,
      }),
  };
};

const uploadOne = async (target: SkillTarget, dir: string, file: File) => {
  const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
  await getTrpc().skills.writeFile.mutate({
    ...target,
    data,
    encoding: "base64",
    path: uploadPath(dir, file.name),
  });
};

const rowClass = (active: boolean) =>
  `w-full truncate rounded-md py-1 pr-2 text-left text-sm hover:bg-muted ${
    active ? "bg-muted font-medium text-foreground" : "text-muted-foreground"
  }`;

function TreeRowButton({
  active,
  onPick,
  row,
}: {
  active: boolean;
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
        {row.name}
      </button>
    </li>
  );
}

function SkillFileEditor({
  agentId,
  onChanged,
  onClosed,
  path,
  scope,
  skill,
}: SkillTarget & {
  onChanged: () => void;
  onClosed: () => void;
  path: string;
}) {
  const io = useMemo(
    () => skillFileIo({ agentId, scope, skill }, path),
    [agentId, path, scope, skill]
  );
  return (
    <LibraryFilePanel
      io={io}
      onChanged={onChanged}
      onClosed={onClosed}
      path={path}
    />
  );
}

export interface SkillFilesPanelProps extends SkillTarget {
  onChanged: () => void;
  onClosed: () => void;
}

/** One skill folder: its files as a tree, add and upload, and an editor for the selected file. */
export function SkillFilesPanel({
  agentId,
  onChanged,
  onClosed,
  scope,
  skill,
}: SkillFilesPanelProps) {
  const [files, setFiles] = useState<SkillTreeFile[] | undefined>();
  const [treeError, setTreeError] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [uploadDir, setUploadDir] = useState("");
  const [newPath, setNewPath] = useState("");
  const [addError, setAddError] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);
  // The skill this panel shows. Null after unmount, so a late response is dropped.
  const shownSkill = useRef<string | null>(null);
  const skillKey = `${agentId}\n${scope}\n${skill}`;

  useEffect(() => {
    shownSkill.current = skillKey;
    return () => {
      shownSkill.current = null;
    };
  }, [skillKey]);

  const reloadTree = useCallback(async (): Promise<
    SkillTreeFile[] | undefined
  > => {
    try {
      const next = await getTrpc().skills.files.query({
        agentId,
        scope,
        skill,
      });
      if (shownSkill.current !== skillKey) {
        return;
      }
      setFiles(next);
      setTreeError(undefined);
      return next;
    } catch (cause) {
      if (shownSkill.current === skillKey) {
        setTreeError(errorMessage(cause));
      }
    }
  }, [agentId, scope, skill, skillKey]);

  useEffect(() => {
    reloadTree().then((next) => {
      if (next?.some((file) => file.path === SKILL_FILE)) {
        setSelected((current) => current ?? SKILL_FILE);
      }
    });
  }, [reloadTree]);

  const rows = useMemo(
    () => treeRows((files ?? []).map((file) => file.path)),
    [files]
  );

  const pickRow = useCallback((row: TreeRow) => {
    if (row.kind === "dir") {
      setUploadDir(row.path);
    } else {
      setSelected(row.path);
    }
  }, []);

  const pickRoot = useCallback(() => setUploadDir(""), []);

  const deselect = useCallback(() => setSelected(undefined), []);

  const fileChanged = useCallback(() => {
    reloadTree();
    onChanged();
  }, [reloadTree, onChanged]);

  const changeNewPath = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setNewPath(event.target.value),
    []
  );

  const addFile = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const path = newPath.trim();
      const problem = validNewFilePath(path);
      if (problem !== null) {
        setAddError(problem);
        return;
      }
      if (files?.some((file) => file.path === path)) {
        setAddError("A file with this path already exists");
        return;
      }
      setAddError(undefined);
      try {
        await getTrpc().skills.writeFile.mutate({
          agentId,
          data: "",
          encoding: "text",
          path,
          scope,
          skill,
        });
      } catch (cause) {
        if (shownSkill.current === skillKey) {
          setAddError(errorMessage(cause));
        }
        return;
      }
      if (shownSkill.current === skillKey) {
        setNewPath("");
        setSelected(path);
        reloadTree();
        onChanged();
      }
    },
    [agentId, files, newPath, onChanged, reloadTree, scope, skill, skillKey]
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
      const target = { agentId, scope, skill };
      const problems: string[] = [];
      setUploadError(undefined);
      setUploading(true);
      try {
        // Uploads run one after the other so a batch never races itself.
        for (const file of chosen) {
          if (file.size > MAX_UPLOAD_BYTES) {
            problems.push(`${file.name} is larger than 10 MB and was skipped.`);
            continue;
          }
          try {
            // biome-ignore lint/performance/noAwaitInLoops: sequential by design, see above
            await uploadOne(target, dir, file);
          } catch (cause) {
            problems.push(errorMessage(cause));
          }
        }
      } finally {
        input.value = "";
        if (shownSkill.current === skillKey) {
          setUploading(false);
          setUploadError(
            problems.length === 0 ? undefined : problems.join(" ")
          );
        }
      }
      if (shownSkill.current === skillKey) {
        reloadTree();
        onChanged();
      }
    },
    [agentId, onChanged, reloadTree, scope, skill, skillKey, uploadDir]
  );

  const uploadLabel = uploadDir === "" ? "skill root" : uploadDir;

  let treeBody: ReactNode;
  if (files === undefined) {
    treeBody =
      treeError === undefined ? (
        <p className="text-muted-foreground text-sm">Loading files.</p>
      ) : null;
  } else {
    treeBody = (
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
            {skill}/
          </button>
        </li>
        {rows.map((row) => (
          <TreeRowButton
            active={
              row.kind === "dir"
                ? uploadDir === row.path
                : selected === row.path
            }
            key={`${row.kind}:${row.path}`}
            onPick={pickRow}
            row={row}
          />
        ))}
      </ul>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="truncate font-medium">{skill}</h2>
        <Button onClick={onClosed} type="button" variant="ghost">
          Close
        </Button>
      </header>
      {treeError === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {treeError}
        </p>
      )}
      {treeBody}
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
      {selected === undefined ? null : (
        <SkillFileEditor
          agentId={agentId}
          key={selected}
          onChanged={fileChanged}
          onClosed={deselect}
          path={selected}
          scope={scope}
          skill={skill}
        />
      )}
    </section>
  );
}
