import type { RunTokenClaims } from "../run-tokens.ts";
import { SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { modelOfRun } from "./access-scope.ts";
import {
  type ProxyAccess,
  runTool,
  type ToolRunResult,
  wantsTool,
} from "./fake-tool.ts";
import { buildLaunchContext } from "./launch-context.ts";
import type { RunEventInput, RuntimeAdapter } from "./types.ts";

export interface FakeRuntimeOptions {
  /** How the tool mode reaches the connector proxy. Without it, a tool run fails. */
  proxy?: ProxyAccess;
  /** Mints the run token the tool mode sends to the proxy. Without it, a tool run fails. */
  signToken?: (claims: RunTokenClaims) => Promise<string>;
}

const NEEDS_PROXY =
  "The fake tool mode needs the proxy's base URL (PUBLIC_BASE_URL) and RUN_TOKEN_KEY.";

/**
 * Answers every run with an echo of its input, so the lanes can test against a
 * run that goes end to end before a machine exists. It is the one adapter that
 * finishes the run inside `dispatch`. `createRunsService` registers it only
 * when `devFakeRuntime` is true.
 *
 * A run for a `fake-tool` model, or with a `tool:<name>` marker in its text,
 * calls one tool of the agent's first app through the connector proxy with a
 * real run token and answers with what came back, so a person can watch an
 * agent use an app without a machine.
 */
export const createFakeRuntime = ({
  proxy,
  signToken,
}: FakeRuntimeOptions = {}): RuntimeAdapter => ({
  cancel: () => Promise.resolve(),
  dispatch: async (db, run, agent, deps) => {
    const claimed = await deps.claimRun(SYSTEM_PRINCIPAL, run.id);
    const input = claimed.inputText;
    let result: ToolRunResult = {
      events: [],
      text: `Echo: ${input}`,
    };
    if (wantsTool(modelOfRun(claimed, agent), input)) {
      try {
        if (!(proxy && signToken)) {
          throw new Error(NEEDS_PROXY);
        }
        result = await runTool({
          connectors: (await buildLaunchContext(db, claimed, agent)).connectors,
          proxy,
          runToken: await signToken({
            agentId: claimed.agentId,
            issuedAt: deps.clock.now().getTime(),
            runId: claimed.id,
            workspaceId: claimed.workspaceId,
          }),
          text: input,
        });
      } catch (error) {
        await deps.completeRun(SYSTEM_PRINCIPAL, run.id, {
          error: error instanceof Error ? error.message : String(error),
          status: "failed",
        });
        return;
      }
    }
    const { text } = result;
    const reply: Omit<RunEventInput, "seq"> = {
      payload: { text },
      type: "message.assistant",
    };
    const events: RunEventInput[] = [...result.events, reply].map(
      (event, index) => ({ ...event, seq: index + 1 })
    );
    await deps.ingestRunEvents(SYSTEM_PRINCIPAL, run.id, events);
    await deps.completeRun(SYSTEM_PRINCIPAL, run.id, { status: "done", text });
  },
  kind: "fake",
});
