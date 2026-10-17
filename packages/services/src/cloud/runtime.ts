import type { Database } from "@repo/db";
import { agentConnectors, connectors } from "@repo/db/schema/connectors";
import { and, eq } from "drizzle-orm";
import type { AgentRecord } from "../agents.ts";
import { buildMcpServers } from "../connectors/mcp-servers.ts";
import { isServiceError } from "../errors.ts";
import { importRunTokenKey, signRunToken } from "../run-tokens.ts";
import type { AdapterDeps, RunRecord, RuntimeAdapter } from "../runs/types.ts";
import { SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { CLOUD_LEASE_MS } from "./lease.ts";
import type { CloudRunnerPort } from "./types.ts";

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";

/**
 * Runs in the cloud runner, one Durable Object per session. Dispatch claims
 * the run for the system, then hands the runner what it needs to start. The
 * claim comes first because a run token is only valid while its run is
 * `running`, with the cloud lease (the object's alarm extends it, see
 * `./lease.ts`). A start that fails releases the claim, so the minute sweep
 * offers the run again.
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
    const runToken = await signRunToken(await hmacKey(), {
      agentId: run.agentId,
      issuedAt: deps.clock.now().getTime(),
      runId: run.id,
      workspaceId: run.workspaceId,
    });
    await runner.start({
      agent: {
        id: agent.id,
        instructions: agent.instructions,
        model: agent.model,
        name: agent.name,
        runtimeConfig: agent.runtimeConfig,
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
        await deps.claimRun(SYSTEM_PRINCIPAL, run.id, {
          leaseMs: CLOUD_LEASE_MS,
        });
      } catch (error) {
        if (isServiceError(error) && error.code === "conflict") {
          return;
        }
        throw error;
      }
      try {
        await startRunner(db, run, agent, deps);
      } catch (error) {
        console.error(
          `Starting cloud run ${run.id} failed, the sweep will retry: ${describeError(error)}`
        );
        try {
          await deps.releaseRun(SYSTEM_PRINCIPAL, run.id);
        } catch (releaseError) {
          console.error(
            `Releasing cloud run ${run.id} failed: ${describeError(releaseError)}`
          );
        }
      }
    },
    kind: "cloud",
  };
};
