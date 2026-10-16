import { FILE_SOURCES } from "@repo/db/shared";
import { z } from "zod";
import type { FileInfo } from "#/integrations/trpc/types.ts";

const fileInfoSchema = z.object({
  createdAt: z.string(),
  id: z.string(),
  mime: z.string(),
  name: z.string(),
  runId: z.string().nullable(),
  size: z.number(),
  source: z.enum(FILE_SOURCES),
}) satisfies z.ZodType<FileInfo>;

const errorBodySchema = z.object({ error: z.string() });

/** Uploads one file to the chat. Throws with the server's message on failure. */
export const uploadFile = async (file: File): Promise<FileInfo> => {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch("/api/files", { body: form, method: "POST" });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const parsed = errorBodySchema.safeParse(body);
    throw new Error(
      parsed.success
        ? parsed.data.error
        : `Upload of ${file.name} failed (${response.status})`
    );
  }
  return fileInfoSchema.parse(await response.json());
};
