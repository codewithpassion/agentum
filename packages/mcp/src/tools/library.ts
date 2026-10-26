import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { LibraryBashResult, McpPorts } from "../ports";
import { ToolError } from "../result";
import {
  defineTool,
  READ_ONLY,
  type ToolDefinition,
  WRITE_UPDATE,
} from "./define";

const MAX_SCRIPT_BYTES = 8 * 1024;

/** Runs a script that can change files and cannot be undone. A repeat may change them again. */
const SCRIPT_WRITE: ToolAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
  readOnlyHint: false,
};

const script = z
  .string()
  .min(1)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= MAX_SCRIPT_BYTES,
    { message: "script is limited to 8 KB" }
  )
  .describe(
    "The bash script to run, up to 8 KB measured in UTF-8 bytes. Its working directory is /library."
  );

/** Stdout as it is, then stderr under a label, then the exit code. */
const libraryText = (result: LibraryBashResult): string => {
  const lines: string[] = [];
  if (result.stdout !== "") {
    lines.push(result.stdout);
  }
  if (result.stderr !== "") {
    lines.push("stderr:", result.stderr);
  }
  lines.push(`exit code ${result.exitCode}`);
  return lines.join("\n");
};

const MAX_FILE_BYTES = 10 * 1024 * 1024;
// Linear check: a regex with a repeated group overflows the stack on multi-MB input.
const BASE64_BODY = /^[A-Za-z0-9+/]*$/;
const isBase64 = (value: string): boolean => {
  if (value.length % 4 !== 0) {
    return false;
  }
  const padding = value.endsWith("==") ? 2 : Number(value.endsWith("="));
  return BASE64_BODY.test(value.slice(0, value.length - padding));
};
const path = z
  .string()
  .min(1)
  .describe(
    "Library path from library_list, without /library; use the task folder agents/<slug>/tasks/<runId>/ for task files."
  );

const base64Of = (bytes: Uint8Array): string => {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(chunks.join(""));
};

// V4.13 leaves binary detection unspecified: valid UTF-8 without NUL is text.
// Preserve BOMs so reading and writing the returned content preserves bytes.
const contentOf = (
  bytes: Uint8Array
): { content: string; encoding: "text" | "base64" } => {
  if (!bytes.includes(0)) {
    try {
      return {
        content: new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes),
        encoding: "text",
      };
    } catch {
      // Invalid UTF-8 is binary; return every byte as base64.
    }
  }
  return { content: base64Of(bytes), encoding: "base64" };
};

export const libraryTools = (ports: McpPorts): ToolDefinition[] => [
  defineTool({
    annotations: READ_ONLY,
    description:
      "Lists files and folders in one library directory, with etags and metadata. The empty directory is the library root. Use the task folder agents/<slug>/tasks/<runId>/ for task files; paths are relative to /library. Access is limited to the caller's library grants.",
    inputSchema: z.strictObject({
      dir: z
        .string()
        .default("")
        .describe(
          "Library directory; defaults to the root. Use the task folder agents/<slug>/tasks/<runId>/ for task files."
        ),
    }),
    name: "library_list",
    run: async (input) => {
      const entries = await ports.libraryList(input);
      return { data: { entries }, text: JSON.stringify({ entries }, null, 2) };
    },
    title: "List library files",
  }),
  defineTool({
    annotations: READ_ONLY,
    description:
      "Reads a library file and its metadata, including etag. Content is text for valid UTF-8 without NUL, otherwise base64; encoding identifies which. Use the task folder agents/<slug>/tasks/<runId>/ for task files and library_list to find paths.",
    inputSchema: z.strictObject({ path }),
    name: "library_read",
    run: async (input) => {
      const { bytes, entry } = await ports.libraryRead(input);
      const data = { entry, ...contentOf(bytes) };
      return { data, text: JSON.stringify(data, null, 2) };
    },
    title: "Read a library file",
  }),
  defineTool({
    annotations: WRITE_UPDATE,
    description:
      "Writes a library file from text (UTF-8, the default) or base64 bytes, up to 10 MB. Use the task folder agents/<slug>/tasks/<runId>/ for task files. Pass ifEtag from library_read to avoid overwriting a changed file; on conflict read again and reconcile before retrying. Wiki edits without write access use wiki_suggest_edit.",
    inputSchema: z
      .strictObject({
        content: z
          .string()
          .max(4 * Math.ceil(MAX_FILE_BYTES / 3))
          .describe(
            "File content as text or standard padded base64, according to encoding."
          ),
        encoding: z
          .enum(["text", "base64"])
          .default("text")
          .describe("Content encoding; defaults to text (UTF-8)."),
        ifEtag: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional etag from library_read; refuses the write if the file changed."
          ),
        path,
      })
      .refine(
        (input) => input.encoding !== "base64" || isBase64(input.content),
        "Content must be standard padded base64."
      ),
    name: "library_write",
    run: async (input) => {
      const bytes =
        input.encoding === "base64"
          ? Uint8Array.from(atob(input.content), (char) => char.charCodeAt(0))
          : new TextEncoder().encode(input.content);
      if (bytes.byteLength > MAX_FILE_BYTES) {
        throw new ToolError(
          "validation",
          "Library files are limited to 10 MB."
        );
      }
      const entry = await ports
        .libraryWrite({
          bytes,
          path: input.path,
          ...(input.ifEtag === undefined ? {} : { ifEtag: input.ifEtag }),
        })
        .catch((error: unknown) => {
          if (error instanceof ToolError && error.code === "conflict") {
            throw new ToolError(
              "conflict",
              `${error.message}. Call library_read for the current content and etag, reconcile your change, then retry library_write with that etag as ifEtag.`
            );
          }
          throw error;
        });
      return { data: { entry }, text: JSON.stringify({ entry }, null, 2) };
    },
    title: "Write a library file",
  }),
  defineTool({
    annotations: READ_ONLY,
    description:
      "Lists a library file's versions newest first, including author, etag and operation. History remains available after deletion. Use the task folder agents/<slug>/tasks/<runId>/ for task files; paths come from library_list or library_read.",
    inputSchema: z.strictObject({ path }),
    name: "library_versions",
    run: async (input) => {
      const versions = await ports.libraryVersions(input);
      return {
        data: { versions },
        text: JSON.stringify({ versions }, null, 2),
      };
    },
    title: "List library file versions",
  }),
  defineTool({
    annotations: SCRIPT_WRITE,
    description:
      'Runs a bash script in a sandbox over the workspace\'s file library. The library is mounted at /library, which is the working directory. Task files go in agents/<slug>/tasks/<runId>/ under /library. Files there persist and are shared by every agent and person in the workspace. Files outside /library exist only for this call and vanish afterwards. python3, sqlite3, tar and js-exec are not available. An agent that runs in the isolate can run JavaScript and TypeScript with its run_script tool. curl works for an agent that has network access turned on, and sends the request through the platform. It accepts http and https only, and refuses private, loopback, link-local and internal addresses. Redirects are always followed and checked. Answers are capped at 5 MB, and curl has a 30 second limit (the 10 second run limit of the script still applies). These curl flags are supported: -s -S -X -H -d -I -i -o -u -A -f -L. When network access is off for the agent, or the caller is not an agent run, curl says "Network access is off for this agent." and fails. Most coreutils, grep, sed, awk, jq, find and sort work. Every call starts a fresh shell, so variables and cd do not carry over between calls. Limits: 10 seconds of run time, 8 KB of script, at most 2,000 storage calls (a recursive grep over hundreds of files can use many), and at most 64 KB each of stdout and stderr is returned. The result gives stdout, stderr and the exit code. A non-zero exit code is a normal result to read, not a tool failure.',
    inputSchema: z.strictObject({ script }),
    name: "bash",
    run: async (input) => {
      const result = await ports.libraryBash({ script: input.script });
      return {
        data: {
          exitCode: result.exitCode,
          stderr: result.stderr,
          stderrTruncated: result.stderrTruncated,
          stdout: result.stdout,
          stdoutTruncated: result.stdoutTruncated,
          storageCalls: result.storageCalls,
          wallMs: result.wallMs,
        },
        text: libraryText(result),
      };
    },
    title: "Run a shell script on the workspace library",
  }),
];
