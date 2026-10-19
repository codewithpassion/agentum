import type { Database } from "@repo/db";
import { agentConnectors, connectors } from "@repo/db/schema/connectors";
import { and, eq } from "drizzle-orm";
import type { AgentRecord } from "../agents.ts";
import { buildMcpServers } from "../connectors/mcp-servers.ts";
import { importRunTokenKey, signRunToken } from "../run-tokens.ts";
import type { AdapterDeps, RunRecord, RuntimeAdapter } from "../runs/types.ts";
import { slackGuidanceFor } from "../slack/guidance.ts";
import type { CloudRunnerPort } from "./types.ts";

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";

/**
 * Runs in the cloud runner, one Durable Object per session. Dispatch only
 * wakes the runner with what it needs to start. The runner claims the run
 * when it can start it, outside the request. A claim made inside a request
 * that the browser cancels would strand the run until its lease expired. A
 * failed wake leaves the run queued or offered for the minute sweep. The run
 * token is signed before the claim, which is fine because it is only checked
 * when used.
 */
export const createCloudRuntime = ({
  platformUrl,
  runner,
  runTokenKey,
}: {
  platformUrl: string;
  runner: CloudRunnerPort;
  runTokenKey: string;
}): RuntimeAdapter => {
  let importedKey: Promise<CryptoKey> | undefined;
  const hmacKey = () => {
    importedKey ??= importRunTokenKey(runTokenKey);
    return importedKey;
  };

  const startRunner = async (
    db: Database,
    run: RunRecord,
    agent: AgentRecord,
    deps: AdapterDeps
  ): Promise<void> => {
    const assigned = await db
      .select({ id: connectors.id, name: connectors.name })
      .from(agentConnectors)
      .innerJoin(connectors, eq(connectors.id, agentConnectors.connectorId))
      .where(
        and(
          eq(agentConnectors.agentId, run.agentId),
          eq(agentConnectors.workspaceId, run.workspaceId)
        )
      )
      .orderBy(agentConnectors.createdAt, agentConnectors.connectorId);
    const slack = await slackGuidanceFor(db, {
      agentId: run.agentId,
      workspaceId: run.workspaceId,
    });
    const runToken = await signRunToken(await hmacKey(), {
      agentId: run.agentId,
      issuedAt: deps.clock.now().getTime(),
      runId: run.id,
      workspaceId: run.workspaceId,
    });
    await runner.start({
      agent: {
        id: agent.id,
        instructions: [agent.instructions, slack]
          .filter((part) => part !== "")
          .join("\n\n"),
        model: agent.model,
        name: agent.name,
        runtimeConfig: agent.runtimeConfig,
        slug: agent.slug,
      },
      inputFileIds: run.inputFileIds,
      mcpServers: buildMcpServers({
        connectors: assigned,
        platformUrl,
        runToken,
      }),
      run: {
        agentId: run.agentId,
        id: run.id,
        inputText: run.inputText,
        sessionId: run.sessionId,
        workspaceId: run.workspaceId,
      },
      runToken,
    });
  };

  return {
    cancel: async (_db, run) => {
      try {
        await runner.cancel(run.id, run.sessionId);
      } catch (error) {
        console.error(
          `Stopping cloud run ${run.id} failed: ${describeError(error)}`
        );
      }
    },
    dispatch: async (db, run, agent, deps) => {
      try {
        await startRunner(db, run, agent, deps);
      } catch (error) {
        console.error(
          `Starting cloud run ${run.id} failed, the sweep will retry: ${describeError(error)}`
        );
      }
    },
    kind: "cloud",
    offerNextOnEnd: true,
  };
};
