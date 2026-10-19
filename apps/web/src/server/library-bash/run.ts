/**
 * Runs one `bash` tool call (F.2): a fresh just-bash shell whose `/library`
 * is the workspace library and whose everything else is scratch memory that
 * vanishes with the call. Nothing is shared between calls but the library.
 */
import type { LibraryBashResult } from "@repo/mcp/ports";
import { Bash, InMemoryFs, MountableFs } from "just-bash/browser";
import type { WebFetcher } from "../web-fetch/types.ts";
import { curlCommand } from "./curl.ts";
import {
  createLibraryFs,
  type LibraryOps,
  STORAGE_BUDGET_MESSAGE,
} from "./library-fs.ts";

export const LIBRARY_MOUNT = "/library";

/** The hardened profile caps loops and command counts. These are on top of it. */
export const BASH_LIMITS = {
  /** Wall time per script. */
  maxExecutionTimeMs: 10_000,
  /** Output, redirected writes included. It also caps the size of a file a script can build. */
  maxOutputSize: 10 * 1024 * 1024,
  /** Storage calls per tool call. */
  maxStorageCalls: 2000,
  /** What each of stdout and stderr returns to the model. */
  maxStreamBytes: 64 * 1024,
} as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Keeps the first `maxStreamBytes` of `text` and says so when it cuts. */
const capStream = (text: string): { text: string; truncated: boolean } => {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= BASH_LIMITS.maxStreamBytes) {
    return { text, truncated: false };
  }
  const kept = decoder.decode(bytes.slice(0, BASH_LIMITS.maxStreamBytes));
  return {
    text: `${kept}\n[truncated: showing the first ${BASH_LIMITS.maxStreamBytes} of ${bytes.byteLength} bytes]`,
    truncated: true,
  };
};

export const runLibraryBash = async ({
  onCurl,
  ops,
  script,
  web,
}: {
  /** Called each time the script starts `curl`, whether or not it is allowed to send. */
  onCurl?: () => void;
  ops: LibraryOps;
  script: string;
  web?: WebFetcher;
}): Promise<LibraryBashResult> => {
  const abort = new AbortController();
  const library = createLibraryFs({
    budget: BASH_LIMITS.maxStorageCalls,
    onBudgetExceeded: () => abort.abort(),
    ops,
  });
  const bash = new Bash({
    customCommands: [curlCommand(web, onCurl)],
    cwd: LIBRARY_MOUNT,
    executionLimitProfile: "hardened",
    executionLimits: {
      maxExecutionTimeMs: BASH_LIMITS.maxExecutionTimeMs,
      maxOutputSize: BASH_LIMITS.maxOutputSize,
    },
    fs: new MountableFs({
      base: new InMemoryFs(),
      mounts: [{ filesystem: library.fs, mountPoint: LIBRARY_MOUNT }],
    }),
  });
  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    // rawScript keeps the leading whitespace of heredoc lines.
    const result = await bash.exec(script, {
      rawScript: true,
      signal: abort.signal,
    });
    ({ exitCode, stderr, stdout } = result);
  } catch (error) {
    exitCode = 1;
    stderr = `bash: ${error instanceof Error ? error.message : "the script failed"}\n`;
  }
  if (library.budgetExceeded()) {
    exitCode = exitCode === 0 ? 1 : exitCode;
    stderr += `${STORAGE_BUDGET_MESSAGE(BASH_LIMITS.maxStorageCalls)}\n`;
  }
  const out = capStream(stdout);
  const err = capStream(stderr);
  return {
    exitCode,
    stderr: err.text,
    stderrTruncated: err.truncated,
    stdout: out.text,
    stdoutTruncated: out.truncated,
    storageCalls: library.storageCalls(),
    wallMs: Date.now() - started,
  };
};
