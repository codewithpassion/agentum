import { z } from "zod";
import type { McpPorts } from "./ports";
import { agentumTools } from "./server";
import { defineTool, type ToolDefinition, WRITE_CREATE } from "./tools/define";

/** Credentials must never enter a completion, even as a tool result. */
export const ASSISTANT_EXCLUDED_TOOLS = new Set([
  "create_secret",
  "create_api_key",
  "revoke_api_key",
  "create_enrolment_code",
  // Both can return a trigger's secret: create_trigger mints one, and
  // set_trigger_enabled mints one when it approves a proposal.
  "create_trigger",
  "set_trigger_enabled",
  "delete_connector",
  "computer_exec",
  "computer_read_file",
  "computer_write_file",
  "computer_edit_file",
  "computer_list_dir",
  "desktop_input",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_screenshot",
]);
export const CARD_DECLINED_NOTE =
  "The person declined. Don't ask for it in chat or another way. Say what is blocked and go on without it.";
const reason = z.string().trim().min(1).max(1000);
const ref = z.string().trim().min(1).max(200);
export const secretCardSchema = z.strictObject({
  grantTo: z.array(ref).max(100).optional(),
  hosts: z.array(z.string().min(1).max(253)).max(100).optional(),
  mode: z.enum(["env", "proxy"]),
  name: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .max(200),
  reason,
  rules: z
    .array(
      z.strictObject({
        header: ref,
        host: z.string().min(1).max(253),
        template: z.string().min(1).max(1000),
      })
    )
    .max(100)
    .optional(),
});
export const modelKeyCardSchema = z.strictObject({
  provider: z.enum(["anthropic", "openrouter"]),
  reason,
});
const card = (name: string, inputSchema: z.ZodType): ToolDefinition =>
  defineTool({
    annotations: WRITE_CREATE,
    description: `Call this tool to open a secure form; never offer to collect a value in chat. The value goes directly to storage and you never see it. ${CARD_DECLINED_NOTE} Never request the same thing twice in a turn.`,
    inputSchema,
    name,
    run: () =>
      Promise.reject(new Error("Card tools must pause the assistant turn")),
    title: name === "request_secret" ? "Add secret" : "Set model provider key",
  });
export const assistantCardTools = [
  card("request_secret", secretCardSchema),
  card("request_model_key", modelKeyCardSchema),
];

/** Session-only composition; the remote MCP registration stays unchanged. */
export const assistantTools = (
  ports: McpPorts,
  isAdmin: boolean
): readonly ToolDefinition[] => [
  ...agentumTools(ports, { admin: isAdmin ? "admin" : "write", qa: true })
    .filter((tool) => !ASSISTANT_EXCLUDED_TOOLS.has(tool.name))
    .map((tool) =>
      tool.name === "archive_agent"
        ? {
            ...tool,
            annotations: { ...tool.annotations, destructiveHint: true },
          }
        : tool
    ),
  ...(isAdmin ? assistantCardTools : []),
];
