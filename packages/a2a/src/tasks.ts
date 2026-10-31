import { z } from "zod";
import { artifactSchema, messageSchema, structSchema } from "./messages.ts";
import { exactlyOneOf } from "./oneof.ts";
import { taskStateSchema } from "./states.ts";

/** ISO 8601 in UTC with a `Z` suffix, as spec section 5.6.1 requires. */
const timestampSchema = z.iso.datetime();

export const taskStatusSchema = z.object({
  message: messageSchema.optional(),
  state: taskStateSchema,
  timestamp: timestampSchema.optional(),
});
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
  artifacts: z.array(artifactSchema).optional(),
  contextId: z.string().optional(),
  history: z.array(messageSchema).optional(),
  id: z.string().min(1),
  metadata: structSchema.optional(),
  status: taskStatusSchema,
});
export type Task = z.infer<typeof taskSchema>;

export const taskStatusUpdateEventSchema = z.object({
  contextId: z.string().min(1),
  metadata: structSchema.optional(),
  status: taskStatusSchema,
  taskId: z.string().min(1),
});
export type TaskStatusUpdateEvent = z.infer<typeof taskStatusUpdateEventSchema>;

export const taskArtifactUpdateEventSchema = z.object({
  append: z.boolean().optional(),
  artifact: artifactSchema,
  contextId: z.string().min(1),
  lastChunk: z.boolean().optional(),
  metadata: structSchema.optional(),
  taskId: z.string().min(1),
});
export type TaskArtifactUpdateEvent = z.infer<
  typeof taskArtifactUpdateEventSchema
>;

const STREAM_PAYLOAD_KEYS = [
  "task",
  "message",
  "statusUpdate",
  "artifactUpdate",
] as const;

/** One streamed event, and the body of a push notification. Holds exactly one member. */
export const streamResponseSchema = z
  .object({
    artifactUpdate: taskArtifactUpdateEventSchema.optional(),
    message: messageSchema.optional(),
    statusUpdate: taskStatusUpdateEventSchema.optional(),
    task: taskSchema.optional(),
  })
  .refine(exactlyOneOf(STREAM_PAYLOAD_KEYS), {
    message:
      "A stream response holds exactly one of task, message, statusUpdate and artifactUpdate",
  });
export type StreamResponse = z.infer<typeof streamResponseSchema>;
