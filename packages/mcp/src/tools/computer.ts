import { DesktopInputRequestSchema } from "@repo/protocol/computer";
import { z } from "zod";
import type { McpPorts, PortResult } from "../ports";
import { ToolError, type ToolErrorCode, type ToolPayload } from "../result";
import {
  MAX_READ_BYTES,
  TOOL_OUTPUT_MAX_BYTES,
  truncateText,
  validateContent,
  validatePath,
  withTruncationNote,
} from "./computer-support";
import {
  defineTool,
  READ_ONLY,
  type ToolDefinition,
  WRITE_CREATE,
  WRITE_UPDATE,
} from "./define";

const guidance = {
  conflict:
    "The target changed or is ambiguous. Read its current state before retrying.",
  desktop_busy:
    "The desktop is busy in another session. Wait until it is released before retrying.",
  desktop_unavailable:
    "The desktop is unavailable. Use file and shell tools or ask the person to enable the desktop.",
  human_in_control:
    "A person is controlling the desktop. Wait for them to hand control back before retrying.",
  not_found:
    "The target was not found. List or snapshot first and choose an existing target.",
  offline:
    "The computer or browser is offline. Ask the person to reconnect it, then retry.",
  timeout:
    "The operation timed out. Check the current state before retrying; it may have partially completed.",
  validation: "The request was refused. Correct the arguments before retrying.",
};

export const portValue = <T extends object>(result: PortResult<T>): T => {
  if (!result.ok) {
    // Existing ToolError codes suffice: transport state is a conflict, unavailable features forbidden.
    let code: ToolErrorCode = "conflict";
    if (result.code === "desktop_unavailable") {
      code = "forbidden";
    }
    if (result.code === "validation" || result.code === "not_found") {
      ({ code } = result);
    }
    throw new ToolError(
      code,
      `${result.code}: ${guidance[result.code]}${result.reason ? ` ${result.reason}` : ""}`
    );
  }
  const { ok: _ok, ...value } = result;
  return value as T;
};
export const jsonPayload = (data: object): ToolPayload => ({
  data,
  text: JSON.stringify(data, null, 2),
});
const pathSchema = z.string().transform((raw, ctx) => {
  const result = validatePath(raw);
  if (!result.ok) {
    ctx.addIssue({ code: "custom", message: result.reason });
    return z.NEVER;
  }
  return result.path;
});
const contentSchema = z
  .string()
  .max(500_000)
  .refine(
    (content) => validateContent(content).ok,
    "File exceeds the byte limit."
  );
const checkedContent = (content: string, maxBytes?: number): string => {
  const result = validateContent(content, maxBytes);
  if (!result.ok) {
    throw new ToolError("validation", result.reason);
  }
  return result.content;
};
const pathInput = z.strictObject({ path: pathSchema });

export const computerTools = (
  ports: Pick<McpPorts, "computer">,
  { desktop }: { desktop: boolean }
): ToolDefinition[] => {
  const { computer } = ports;
  if (!computer) {
    return [];
  }
  return [
    defineTool({
      annotations: WRITE_CREATE,
      description:
        "Run a shell command on your computer. Returns stdout, stderr and exit code; long output is truncated with a note. A nonzero exit is a normal result. Paths and working directory follow the bound computer's shell.",
      inputSchema: z.strictObject({
        command: z.string().min(1).max(4000),
        timeout_ms: z.number().int().positive().max(600_000).default(30_000),
      }),
      name: "computer_exec",
      run: async (input) => {
        const result = portValue(await computer.exec(input));
        return jsonPayload({
          exitCode: result.exitCode,
          stderr: withTruncationNote(
            truncateText(result.stderr, TOOL_OUTPUT_MAX_BYTES)
          ),
          stdout: withTruncationNote(
            truncateText(result.stdout, TOOL_OUTPUT_MAX_BYTES)
          ),
        });
      },
      title: "Run a command on your computer",
    }),
    defineTool({
      annotations: READ_ONLY,
      description:
        "Read a file by absolute logical computer path. Large files are refused rather than silently cut; list the directory first to see sizes.",
      inputSchema: pathInput,
      name: "computer_read_file",
      run: async ({ path }) => {
        const result = portValue(await computer.readFile({ path }));
        if (result.size > MAX_READ_BYTES) {
          throw new ToolError(
            "validation",
            "File is too large to read; use computer_exec to read a smaller section."
          );
        }
        checkedContent(result.content, MAX_READ_BYTES);
        return jsonPayload({ ...result, path });
      },
      title: "Read a file on your computer",
    }),
    defineTool({
      annotations: WRITE_UPDATE,
      description:
        "Create or overwrite a file at an absolute logical computer path; missing parents are created. Use computer_edit_file to change part of an existing file.",
      inputSchema: z.strictObject({ content: contentSchema, path: pathSchema }),
      name: "computer_write_file",
      run: async (input) =>
        jsonPayload({
          ...portValue(await computer.writeFile(input)),
          path: input.path,
        }),
      title: "Write a file on your computer",
    }),
    defineTool({
      annotations: WRITE_CREATE,
      description:
        "Replace exactly one occurrence of old_string with new_string. Read the file first and include enough surrounding text to make the match unique.",
      inputSchema: z.strictObject({
        new_string: contentSchema,
        old_string: z.string().min(1).max(MAX_READ_BYTES),
        path: pathSchema,
      }),
      name: "computer_edit_file",
      run: async ({ path, old_string, new_string }) => {
        const result = portValue(await computer.readFile({ path }));
        checkedContent(result.content, MAX_READ_BYTES);
        if (result.size > MAX_READ_BYTES) {
          throw new ToolError(
            "validation",
            "File is too large to edit; use computer_exec to edit a smaller section."
          );
        }
        const index = result.content.indexOf(old_string);
        if (
          !old_string ||
          index < 0 ||
          result.content.indexOf(old_string, index + 1) >= 0
        ) {
          throw new ToolError(
            "conflict",
            "old_string must occur exactly once. Read the file and include more context before retrying."
          );
        }
        // The specified port has no atomic edit/CAS method; callers must coordinate concurrent edits.
        const content = checkedContent(
          result.content.slice(0, index) +
            new_string +
            result.content.slice(index + old_string.length)
        );
        const written = portValue(await computer.writeFile({ content, path }));
        return jsonPayload({ path, size: written.size });
      },
      title: "Edit a file on your computer",
    }),
    defineTool({
      annotations: READ_ONLY,
      description:
        "List entries, sizes and directory markers at an absolute logical computer path. Start at /.",
      inputSchema: pathInput,
      name: "computer_list_dir",
      run: async ({ path }) =>
        jsonPayload({ ...portValue(await computer.listDir({ path })), path }),
      title: "List a directory on your computer",
    }),
    ...(desktop
      ? [
          defineTool({
            annotations: WRITE_CREATE,
            description:
              "Send an ordered v1 desktop action batch. Coordinates are 1280x800 desktop pixels. Use desktop_screenshot to see the result; wait if a person controls the desktop.",
            inputSchema: z.strictObject({
              actions: DesktopInputRequestSchema.shape.actions,
            }),
            name: "desktop_input",
            run: async (input) => {
              portValue(await computer.desktopInput(input));
              return jsonPayload({ applied: input.actions.length });
            },
            title: "Control your desktop",
          }),
        ]
      : []),
  ];
};
