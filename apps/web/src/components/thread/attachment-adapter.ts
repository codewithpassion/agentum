import type {
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from "@assistant-ui/react";
import type { FileInfo } from "#/integrations/trpc/types.ts";
import { uploadFile } from "./upload-file.ts";

/** The content part that carries a server file id through assistant-ui's attachment model. */
export const fileIdPart = (
  info: Pick<FileInfo, "id" | "mime" | "name">
): CompleteAttachment["content"][number] => ({
  data: info.id,
  filename: info.name,
  mimeType: info.mime,
  type: "file",
});

/** The attachment the library picker adds: complete at once, since the file is already on the server. */
export const libraryAttachment = (info: FileInfo) => ({
  content: [fileIdPart(info)],
  contentType: info.mime,
  id: info.id,
  name: info.name,
  type: "file",
});

/**
 * Uploads each picked file to `/api/files` as soon as it is added, so the
 * person sees a failure before sending. The server's file id travels in a
 * `file` content part of the sent attachment, and `onNew` reads it from there.
 */
export const createAttachmentAdapter = (
  upload: (file: File) => Promise<FileInfo> = uploadFile
): AttachmentAdapter => {
  const uploaded = new Map<string, FileInfo>();
  return {
    accept: "*",
    async *add({ file }) {
      const id = crypto.randomUUID();
      const base = {
        contentType: file.type,
        file,
        id,
        name: file.name,
        type: "file",
      } as const;
      yield {
        ...base,
        status: { progress: 0, reason: "uploading", type: "running" },
      };
      uploaded.set(id, await upload(file));
      yield {
        ...base,
        status: { reason: "composer-send", type: "requires-action" },
      };
    },
    remove(attachment) {
      uploaded.delete(attachment.id);
      return Promise.resolve();
    },
    send(attachment: PendingAttachment) {
      const info = uploaded.get(attachment.id);
      if (info === undefined) {
        return Promise.reject(
          new Error(`${attachment.name} was not uploaded.`)
        );
      }
      uploaded.delete(attachment.id);
      return Promise.resolve({
        ...attachment,
        content: [fileIdPart(info)],
        status: { type: "complete" },
      });
    },
  };
};
