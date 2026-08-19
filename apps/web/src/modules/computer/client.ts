import type { Db } from "#/db/client";
import { logActivity } from "#/modules/activity/service";
import {
  summarizeEdit,
  summarizeExec,
  summarizeExecFailure,
  summarizeWrite,
} from "./activity";
import { ACTIVITY_STREAM_MAX_BYTES, truncateText } from "./output";
import { MAX_READ_BYTES, validateContent, validatePath } from "./paths";
import type { ExecResult, ListResult, ReadResult, WriteResult } from "./types";

/**
 * The internal face of an agent's computer. Everything - MCP tools, the `/api`
 * routes, and later the UI's uploads - goes through this interface, so path
 * rules, size caps and the activity log are applied exactly once and the
 * `@cloudflare/computer` Durable Object stays behind it.
 */
export interface AgentComputerClient {
  editFile: (
    path: string,
    oldString: string,
    newString: string
  ) => Promise<WriteResult>;
  exec: (command: string) => Promise<ExecResult>;
  listDir: (path: string) => Promise<ListResult>;
  readFile: (path: string, maxBytes?: number) => Promise<ReadResult>;
  writeFile: (path: string, content: string) => Promise<WriteResult>;
}

const MAX_COMMAND_LENGTH = 4000;
const MAX_EDIT_STRING_LENGTH = 100_000;

const stubFor = (env: Env, agentId: string) =>
  env.AGENT_COMPUTER.get(env.AGENT_COMPUTER.idFromName(agentId));

export const createComputerClient = (
  db: Db,
  env: Env,
  agentId: string
): AgentComputerClient => {
  const stub = stubFor(env, agentId);

  return {
    async editFile(path, oldString, newString) {
      const target = validatePath(path);
      if (!target.ok) {
        return target;
      }
      if (typeof oldString !== "string" || oldString.length === 0) {
        return { ok: false, reason: "old_string is required." };
      }
      if (
        oldString.length > MAX_EDIT_STRING_LENGTH ||
        (newString?.length ?? 0) > MAX_EDIT_STRING_LENGTH
      ) {
        return {
          ok: false,
          reason: `old_string and new_string must each be at most ${MAX_EDIT_STRING_LENGTH} characters.`,
        };
      }

      const result = await stub.editFile(target.path, oldString, newString);
      if (result.ok) {
        await logActivity(db, {
          agentId,
          detail: { path: target.path, size: result.size },
          kind: "computer.edit",
          summary: summarizeEdit({ path: target.path }),
        });
      }
      return result;
    },

    async exec(command) {
      if (typeof command !== "string" || command.trim().length === 0) {
        return { ok: false, reason: "A command is required." };
      }
      if (command.length > MAX_COMMAND_LENGTH) {
        return {
          ok: false,
          reason: `Commands must be at most ${MAX_COMMAND_LENGTH} characters.`,
        };
      }

      const result = await stub.exec(command);
      if (result.ok) {
        await logActivity(db, {
          agentId,
          detail: {
            command,
            exitCode: result.exitCode,
            stderr: truncateText(result.stderr, ACTIVITY_STREAM_MAX_BYTES).text,
            stdout: truncateText(result.stdout, ACTIVITY_STREAM_MAX_BYTES).text,
          },
          kind: "computer.exec",
          summary: summarizeExec({ command, exitCode: result.exitCode }),
        });
      } else {
        await logActivity(db, {
          agentId,
          detail: { command, error: result.reason },
          kind: "computer.exec",
          summary: summarizeExecFailure({ command, reason: result.reason }),
        });
      }
      return result;
    },

    async listDir(path) {
      const target = validatePath(path);
      if (!target.ok) {
        return target;
      }
      return await stub.listDir(target.path);
    },

    async readFile(path, maxBytes = MAX_READ_BYTES) {
      const target = validatePath(path);
      if (!target.ok) {
        return target;
      }
      return await stub.readFile(target.path, maxBytes);
    },

    async writeFile(path, content) {
      const target = validatePath(path);
      if (!target.ok) {
        return target;
      }
      const body = validateContent(content);
      if (!body.ok) {
        return body;
      }

      const result = await stub.writeFile(target.path, body.content);
      if (result.ok) {
        await logActivity(db, {
          agentId,
          detail: {
            created: result.created,
            path: target.path,
            size: result.size,
          },
          kind: "computer.write",
          summary: summarizeWrite({
            created: result.created,
            path: target.path,
            size: result.size,
          }),
        });
      }
      return result;
    },
  };
};
