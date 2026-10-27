import { z } from "zod";

const UNSAFE_PATH = /[?#%]/;

/** Untrusted rendered DOM context. Never a speaker, permission or artifact authority. */
export const pageElementSchema = z.strictObject({
  html: z.string().min(1).max(4096),
  path: z
    .string()
    .min(1)
    .max(1024)
    .refine(
      (path) =>
        !(
          path.startsWith("/") ||
          path.includes("\\") ||
          UNSAFE_PATH.test(path)
        ) &&
        path
          .split("/")
          .every((part) => part !== ".." && part !== "." && part !== ""),
      "Expected an artifact-relative file path"
    ),
  selector: z.string().min(1).max(2048),
  tag: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  text: z.string().max(2048),
});
export type PageElement = z.infer<typeof pageElementSchema>;
export const elementAskInputSchema = z.strictObject({
  artifactId: z.uuid(),
  element: pageElementSchema,
  requestId: z.string().min(1).max(200),
  text: z.string().trim().min(1).max(8000),
  versionId: z.string().min(1).max(200),
});
export type ElementAskInput = z.infer<typeof elementAskInputSchema>;
