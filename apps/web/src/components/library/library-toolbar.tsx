import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import { bytesToBase64 } from "#/lib/library-content.ts";
import { joinPath } from "./library-logic.ts";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const uploadFile = async (dir: string, file: File) => {
  const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
  await getTrpc().library.write.mutate({
    data,
    encoding: "base64",
    path: joinPath(dir, file.name),
  });
};

export interface LibraryToolbarProps {
  dir: string;
  onChanged: () => void;
}

export function LibraryToolbar({ dir, onChanged }: LibraryToolbarProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [folderName, setFolderName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openFilePicker = useCallback(() => fileInput.current?.click(), []);

  const handleFilesChosen = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const files = Array.from(input.files ?? []);
      if (files.length === 0) {
        return;
      }
      setError(null);
      setUploading(true);
      try {
        // Uploads run one after the other so a batch never races itself.
        for (const file of files) {
          if (file.size > MAX_UPLOAD_BYTES) {
            setError(`${file.name} is larger than 10 MB.`);
            continue;
          }
          try {
            // biome-ignore lint/performance/noAwaitInLoops: sequential by design, see above
            await uploadFile(dir, file);
          } catch (caught) {
            setError(errorMessage(caught));
          }
        }
      } finally {
        input.value = "";
        setUploading(false);
        onChanged();
      }
    },
    [dir, onChanged]
  );

  const handleFolderNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setFolderName(event.target.value),
    []
  );

  const handleFolderSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const name = folderName.trim();
      if (name === "") {
        return;
      }
      setError(null);
      if (name.includes("/")) {
        setError("A folder name cannot contain /.");
        return;
      }
      try {
        await getTrpc().library.mkdir.mutate({ path: joinPath(dir, name) });
        setFolderName("");
        onChanged();
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [dir, folderName, onChanged]
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-4">
        <Button disabled={uploading} onClick={openFilePicker} type="button">
          {uploading ? "Uploading..." : "Upload"}
        </Button>
        <input
          className="hidden"
          data-testid="library-upload-input"
          hidden
          multiple
          onChange={handleFilesChosen}
          ref={fileInput}
          type="file"
        />
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={handleFolderSubmit}
        >
          <Input
            aria-label="New folder name"
            data-testid="library-folder-name"
            onChange={handleFolderNameChange}
            value={folderName}
          />
          <Button type="submit" variant="outline">
            New folder
          </Button>
        </form>
      </div>
      {error === null ? null : (
        <p
          className="text-destructive text-sm"
          data-testid="library-toolbar-error"
        >
          {error}
        </p>
      )}
    </div>
  );
}
