/** Loopback through the actual bearer-authenticated production MCP HTTP route. */

import { importRunTokenKey, signRunToken } from "@repo/services/run-tokens";
import type { RunRecord } from "@repo/services/runs/types";
import { Hono } from "hono";
import type { Composed } from "./compose";
import type { AppEnv } from "./routes/groups";
import { mcpRoutes } from "./routes/mcp";

export const guestRunRpc =
  (env: Env, composed: Composed) =>
  async (run: RunRecord, method: string, params: unknown, id: string) => {
    const token = await signRunToken(
      await importRunTokenKey(env.RUN_TOKEN_KEY),
      {
        agentId: run.agentId,
        issuedAt: composed.clock.now().getTime(),
        runId: run.id,
        workspaceId: run.workspaceId,
      }
    );
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("composed", composed);
      await next();
    });
    app.route(
      "/mcp",
      mcpRoutes({
        clientName: () => () => Promise.resolve(null),
        dev: false,
        isOrgMember: () => () => Promise.resolve(false),
        log: () => undefined,
        userOrgIds: () => () => Promise.resolve([]),
        verifyOAuthToken: () => () => Promise.resolve(null),
      })
    );
    const response = await app.fetch(
      new Request(new URL("/mcp", env.PUBLIC_BASE_URL), {
        body: JSON.stringify({ id, jsonrpc: "2.0", method, params }),
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Host: new URL(env.PUBLIC_BASE_URL).host,
          "Mcp-Protocol-Version": "2025-06-18",
        },
        method: "POST",
      }),
      env
    );
    if (!response.ok) {
      throw new Error(
        `Scoped MCP authentication refused (${response.status}): ${(await response.text()).slice(0, 500)}`
      );
    }
    const text = await response.text();
    const data = text.split("\n").filter((line) => line.startsWith("data:"));
    const result = JSON.parse(data.at(-1)?.slice(5).trim() ?? text) as {
      error?: unknown;
      result?: {
        isError?: boolean;
        tools?: Array<{ name: string; inputSchema: Record<string, unknown> }>;
      };
    };
    if (result.error || result.result?.isError) {
      throw new Error("Scoped MCP call refused");
    }
    return result.result;
  };
