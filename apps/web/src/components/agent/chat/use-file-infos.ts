import { useCallback, useEffect, useRef, useState } from "react";
import { getTrpc } from "#/integrations/trpc/client";
import type { FileInfo } from "#/integrations/trpc/types.ts";

const DESCRIBE_CHUNK = 100;

const chunk = (ids: readonly string[], size: number): string[][] => {
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += size) {
    chunks.push(ids.slice(start, start + size));
  }
  return chunks;
};

/**
 * Looks up the records behind file ids the chat shows. An id is asked for once;
 * a failed lookup is not retried, and its chips fall back to the label "File".
 */
export const useFileInfos = (
  fileIds: readonly string[]
): {
  files: ReadonlyMap<string, FileInfo>;
  remember: (infos: FileInfo[]) => void;
} => {
  const [files, setFiles] = useState<ReadonlyMap<string, FileInfo>>(
    () => new Map()
  );
  const requested = useRef(new Set<string>());

  const remember = useCallback((infos: FileInfo[]) => {
    for (const info of infos) {
      requested.current.add(info.id);
    }
    setFiles((current) => {
      const next = new Map(current);
      for (const info of infos) {
        next.set(info.id, info);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const missing = fileIds.filter((id) => !requested.current.has(id));
    if (missing.length === 0) {
      return;
    }
    for (const id of missing) {
      requested.current.add(id);
    }
    for (const ids of chunk(missing, DESCRIBE_CHUNK)) {
      getTrpc()
        .files.describe.query({ fileIds: ids })
        .then(remember)
        .catch(() => undefined);
    }
  }, [fileIds, remember]);

  return { files, remember };
};
