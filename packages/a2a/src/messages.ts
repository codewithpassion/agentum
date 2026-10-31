import { z } from "zod";
import { exactlyOneOf } from "./oneof.ts";

/** A JSON object, `google.protobuf.Struct` on the wire. */
export const structSchema = z.record(z.string(), z.json());
export type Struct = z.infer<typeof structSchema>;

const PART_CONTENT_KEYS = ["text", "raw", "url", "data"] as const;

/**
 * One of `text`, `raw` (base64), `url` or `data`, named by the member itself.
 * 1.0 has no `kind` discriminator, so the object is strict and a 0.3 part
 * (`{"kind": "text", "text": "..."}`) is refused.
 */
export const partSchema = z
  .strictObject({
    data: z.json().optional(),
    filename: z.string().optional(),
    mediaType: z.string().optional(),
    metadata: structSchema.optional(),
    raw: z.string().optional(),
    text: z.string().optional(),
    url: z.string().optional(),
  })
  .refine(exactlyOneOf(PART_CONTENT_KEYS), {
    message: "A part holds exactly one of text, raw, url and data",
  });
export type Part = z.infer<typeof partSchema>;

export const ROLES = ["ROLE_USER", "ROLE_AGENT"] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);

export const messageSchema = z.object({
  contextId: z.string().optional(),
  extensions: z.array(z.string()).optional(),
  messageId: z.string().min(1),
  metadata: structSchema.optional(),
  parts: z.array(partSchema).min(1),
  referenceTaskIds: z.array(z.string()).optional(),
  role: roleSchema,
  taskId: z.string().optional(),
});
export type Message = z.infer<typeof messageSchema>;

export const artifactSchema = z.object({
  artifactId: z.string().min(1),
  description: z.string().optional(),
  extensions: z.array(z.string()).optional(),
  metadata: structSchema.optional(),
  name: z.string().optional(),
  parts: z.array(partSchema).min(1),
});
export type Artifact = z.infer<typeof artifactSchema>;
