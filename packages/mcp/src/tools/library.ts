import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { LibraryBashResult, McpPorts } from "../ports";
import { defineTool, type ToolDefinition } from "./define";

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

export const libraryTools = (ports: McpPorts): ToolDefinition[] => [
  defineTool({
    annotations: SCRIPT_WRITE,
    description:
      'Runs a bash script in a sandbox over the workspace\'s file library. The library is mounted at /library, which is the working directory. Files there persist and are shared by every agent and person in the workspace. Files outside /library exist only for this call and vanish afterwards. python3, sqlite3, tar and js-exec are not available. An agent that runs in the isolate can run JavaScript and TypeScript with its run_script tool. curl works for an agent that has network access turned on, and sends the request through the platform. It accepts http and https only, and refuses private, loopback, link-local and internal addresses. Redirects are always followed and checked. Answers are capped at 5 MB, and curl has a 30 second limit (the 10 second run limit of the script still applies). These curl flags are supported: -s -S -X -H -d -I -i -o -u -A -f -L. When network access is off for the agent, or the caller is not an agent run, curl says "Network access is off for this agent." and fails. Most coreutils, grep, sed, awk, jq, find and sort work. Every call starts a fresh shell, so variables and cd do not carry over between calls. Limits: 10 seconds of run time, 8 KB of script, at most 2,000 storage calls (a recursive grep over hundreds of files can use many), and at most 64 KB each of stdout and stderr is returned. The result gives stdout, stderr and the exit code. A non-zero exit code is a normal result to read, not a tool failure.',
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
