import { z } from "zod";
import { messageSchema, structSchema } from "./messages.ts";
import { exactlyOneOf } from "./oneof.ts";
import { taskSchema } from "./tasks.ts";

/** How the server authenticates to a push notification URL. */
export const authenticationInfoSchema = z.object({
  credentials: z.string().optional(),
  scheme: z.string().min(1),
});
export type AuthenticationInfo = z.infer<typeof authenticationInfoSchema>;

export const taskPushNotificationConfigSchema = z.object({
  authentication: authenticationInfoSchema.optional(),
  id: z.string().optional(),
  taskId: z.string().optional(),
  tenant: z.string().optional(),
  token: z.string().optional(),
  url: z.string().min(1),
});
export type TaskPushNotificationConfig = z.infer<
  typeof taskPushNotificationConfigSchema
>;

export const sendMessageConfigurationSchema = z.object({
  acceptedOutputModes: z.array(z.string()).optional(),
  historyLength: z.number().int().min(0).optional(),
  returnImmediately: z.boolean().optional(),
  taskPushNotificationConfig: taskPushNotificationConfigSchema.optional(),
});
export type SendMessageConfiguration = z.infer<
  typeof sendMessageConfigurationSchema
>;

export const sendMessageRequestSchema = z.object({
  configuration: sendMessageConfigurationSchema.optional(),
  message: messageSchema,
  metadata: structSchema.optional(),
  tenant: z.string().optional(),
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

/** The answer to `SendMessage`: a task or a plain message, never both. */
export const sendMessageResponseSchema = z
  .object({
    message: messageSchema.optional(),
    task: taskSchema.optional(),
  })
  .refine(exactlyOneOf(["task", "message"]), {
    message: "A send message response holds exactly one of task and message",
  });
export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;
