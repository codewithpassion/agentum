import type { Database } from "@repo/db";
import type { AgentRecord } from "../agents.ts";
import type { LibraryService } from "../library.ts";
import { libraryMemoryReader } from "../memory/prompt.ts";
import { libraryTeamMemoryReader } from "../memory/team.ts";
import { approvedDecision } from "../requests/outbound.ts";
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
import type {
  AdapterDeps,
  RunEventInput,
  RunRecord,
  RuntimeAdapter,
} from "./types.ts";

export interface FakeRuntimeOptions {
  /**
   * Opens an approval request for a run, as a real runtime does when it wants
   * to use a tool. Without it, an `ask:<tool>` run fails.
   */
  askApproval?: (request: {
    runId: string;
    toolName: string;
    toolUseId: string;
  }) => Promise<void>;
  /** Where the run's memory notes are read from. Without it, the reply carries no notes. */
  library?: Partial<Pick<LibraryService, "read">>;
  /** How the tool mode reaches the connector proxy. Without it, a tool run fails. */
  proxy?: ProxyAccess;
  /** Mints the run token the tool mode sends to the proxy. Without it, a tool run fails. */
  signToken?: (claims: RunTokenClaims) => Promise<string>;
}

/**
 * The notes the run's prompt carries, as a reply suffix, or an empty string
 * when there are none. This is how a person sees that memory reached the run
 * input, since the fake runtime has no model to use it.
 */
const memoryNotesOf = async (
  db: Database,
  run: RunRecord,
  agent: AgentRecord,
  library: FakeRuntimeOptions["library"]
): Promise<string> => {
  try {
    if (!library?.read) {
      return "";
    }
    const { memory } = await buildLaunchContext(db, run, agent, {
      readMemoryFile: libraryMemoryReader(
        { read: library.read },
        run,
        agent.slug
      ),
      readTeamMemoryFile: libraryTeamMemoryReader({ read: library.read }, run),
    });
    const notes = memory ? memory.notes : [];
    return notes.length === 0
      ? ""
      : `\n\nI remember:\n${notes.map((note) => `- ${note.text}`).join("\n")}`;
  } catch (error) {
    // Memory is a nicety here: a run that cannot read it still echoes.
    console.error(
      `Loading memory for fake run ${run.id} failed: ${error instanceof Error ? error.name : "unknown error"}`
    );
    return "";
  }
};

const ASK_MARKER = /ask:([A-Za-z0-9_.-]+)/;
const NEEDS_APPROVALS = "The fake ask mode needs the requests service.";

/** The tool an `ask:<tool>` marker in the task text names, or null. */
const askedToolOf = (text: string): string | null =>
  ASK_MARKER.exec(text)?.[1] ?? null;

/** The same id for a run's one approval, so a retried dispatch opens no second card. */
const toolUseIdOf = (run: RunRecord): string => `fake-ask-${run.id}`;

/** Records the reply as the run's last event and ends the run as done. */
const finishWithText = async (
  deps: AdapterDeps,
  run: RunRecord,
  text: string,
  earlier: readonly Omit<RunEventInput, "seq">[] = []
): Promise<void> => {
  const reply: Omit<RunEventInput, "seq"> = {
    payload: { text },
    type: "message.assistant",
  };
  const events: RunEventInput[] = [...earlier, reply].map((event, index) => ({
    ...event,
    seq: index + 1,
  }));
  await deps.ingestRunEvents(SYSTEM_PRINCIPAL, run.id, events);
  await deps.completeRun(SYSTEM_PRINCIPAL, run.id, { status: "done", text });
};

/** Opens the run's approval, or fails the run when there is no way to. */
const openAsk = async (
  deps: AdapterDeps,
  run: RunRecord,
  toolName: string,
  askApproval: FakeRuntimeOptions["askApproval"]
): Promise<void> => {
  try {
    if (!askApproval) {
      throw new Error(NEEDS_APPROVALS);
    }
    await askApproval({ runId: run.id, toolName, toolUseId: toolUseIdOf(run) });
  } catch (error) {
    await deps.completeRun(SYSTEM_PRINCIPAL, run.id, {
      error: error instanceof Error ? error.message : String(error),
      status: "failed",
    });
  }
};

const NEEDS_PROXY =
  "The fake tool mode needs the proxy's base URL (PUBLIC_BASE_URL) and RUN_TOKEN_KEY.";

/**
 * Answers every run with an echo of its input, so the lanes can test against a
 * run that goes end to end before a machine exists. It is the one adapter that
 * finishes a run inside `dispatch` (an `ask:` run finishes in `resume`). `createRunsService` registers it only
 * when `devFakeRuntime` is true.
 *
 * A run for a `fake-tool` model, or with a `tool:<name>` marker in its text,
 * calls one tool of the agent's first app through the connector proxy with a
 * real run token and answers with what came back, so a person can watch an
 * agent use an app without a machine.
 *
 * A run with an `ask:<tool>` marker in its text opens an approval request for
 * that tool and waits. The answer closes the request, and `resume` then ends
 * the run with a reply that names the decision.
 */
export const createFakeRuntime = ({
  askApproval,
  library,
  proxy,
  signToken,
}: FakeRuntimeOptions = {}): RuntimeAdapter => ({
  cancel: () => Promise.resolve(),
  dispatch: async (db, run, agent, deps) => {
    const claimed = await deps.claimRun(SYSTEM_PRINCIPAL, run.id);
    const input = claimed.inputText;
    const askedTool = askedToolOf(input);
    if (askedTool) {
      await openAsk(deps, run, askedTool, askApproval);
      return;
    }
    const toolMode = wantsTool(modelOfRun(claimed, agent), input);
    // A tool run answers with the tool's result, so it does not list notes.
    const notes = toolMode
      ? ""
      : await memoryNotesOf(db, claimed, agent, library);
    let result: ToolRunResult = {
      events: [],
      text: `Echo: ${input}${notes}`,
    };
    if (toolMode) {
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
    await finishWithText(deps, run, result.text, result.events);
  },
  kind: "fake",
  resume: async (run, request, deps) => {
    if (request.kind !== "approval" || request.toolUseId !== toolUseIdOf(run)) {
      return;
    }
    const decision = approvedDecision(request.outcome) ? "Allowed" : "Denied";
    await finishWithText(deps, run, `${decision} ${request.toolName}.`);
  },
});
