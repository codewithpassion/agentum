import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { machines } from "@repo/db/schema/machines";
import { taskFolderPath } from "@repo/db/shared";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { agentPrompt } from "../agent-prompt.ts";
import type { AgentRecord } from "../agents.ts";
import { buildMcpServers } from "../connectors/mcp-servers.ts";
import { agentGrants } from "../library/access.ts";
import { librarySyncScope } from "../library/sync-paths.ts";
import { importRunTokenKey, signRunToken } from "../run-tokens.ts";
import { requireOrdinaryMachineRun } from "../runs/guest-scope.ts";
import { buildLaunchContext } from "../runs/launch-context.ts";
import type { AdapterDeps, RunRecord, RuntimeAdapter } from "../runs/types.ts";
import { CLOUD_DEFAULT_MODEL, findCloudModel } from "./models.ts";
import type { CloudRunnerPort } from "./types.ts";

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";

const computerCapabilities = z.object({
  desktop: z.boolean().default(false),
});

/** Reads `desktop` from a machine's computer capabilities JSON. Anything else is false. */
const desktopOf = (json: string | null): boolean => {
  if (json === null) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  const result = computerCapabilities.safeParse(parsed);
  return result.success ? result.data.desktop : false;
};

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

  /** The agent's attached computer, absent when none is attached or it is revoked. */
  const computerFor = async (
    db: Database,
    run: RunRecord
  ): Promise<{ desktop: boolean; machineId: string } | undefined> => {
    const [attached] = await db
      .select({ machineId: agents.computerMachineId })
      .from(agents)
      .where(
        and(eq(agents.id, run.agentId), eq(agents.workspaceId, run.workspaceId))
      )
      .limit(1);
    if (!attached?.machineId) {
      return;
    }
    const [machine] = await db
      .select({
        capabilities: machines.computerCapabilities,
        id: machines.id,
      })
      .from(machines)
      .where(
        and(
          eq(machines.id, attached.machineId),
          eq(machines.workspaceId, run.workspaceId),
          ne(machines.status, "revoked")
        )
      )
      .limit(1);
    if (!machine) {
      return;
    }
    return {
      desktop: desktopOf(machine.capabilities),
      machineId: machine.id,
    };
  };

  const startRunner = async (
    db: Database,
    run: RunRecord,
    agent: AgentRecord,
    deps: AdapterDeps
  ): Promise<void> => {
    requireOrdinaryMachineRun(run);
    const computer = await computerFor(db, run);
    const context = await buildLaunchContext(db, run, agent);
    const runToken = await signRunToken(await hmacKey(), {
      agentId: run.agentId,
      issuedAt: deps.clock.now().getTime(),
      runId: run.id,
      workspaceId: run.workspaceId,
    });
    const { model } = context;
    await runner.start({
      agent: {
        id: agent.id,
        instructions: [
          agentPrompt(agent, context.handoffNames, {
            multiPerson: context.multiPerson,
          }),
          context.slack,
        ]
          .filter((part) => part !== "")
          .join("\n\n"),
        model:
          run.dryRun && !findCloudModel(model) ? CLOUD_DEFAULT_MODEL : model,
        name: agent.name,
        runtimeConfig: agent.runtimeConfig,
        slug: agent.slug,
      },
      ...(computer ? { computer } : {}),
      inputFileIds: run.inputFileIds,
      library: {
        roots: librarySyncScope(
          agent.slug,
          await agentGrants(db, run.workspaceId, agent.id)
        ),
        ...(run.dryRun
          ? {}
          : { taskFolder: taskFolderPath(agent.slug, run.id) }),
      },
      mcpServers: buildMcpServers({
        connectors: context.connectors,
        platformUrl,
        runToken,
      }),
      run: {
        agentId: run.agentId,
        dryRun: run.dryRun,
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
      requireOrdinaryMachineRun(run);
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
    resume: async (run, request) => {
      requireOrdinaryMachineRun(run);
      await runner.answered?.(run.id, run.sessionId, request.id);
    },
  };
};
