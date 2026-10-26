/**
 * What the builder does with a draft once the person has reviewed it: save it
 * as a `draft` agent row, run it on a sample, turn it into a working agent, or
 * throw it away. Every write goes through the service that owns it, so each
 * keeps its own checks and events. None of them takes an outer `atomic`, which
 * is why `create` goes step by step and says what landed when one fails.
 */
import type { VoicePreset } from "@repo/db/shared";
import { z } from "zod";
import type { AgentRecord, AgentsService } from "../agents.ts";
import { CLOUD_DEFAULT_MODEL } from "../cloud/models.ts";
import type { ConnectorsService } from "../connectors.ts";
import { isServiceError, ServiceError } from "../errors.ts";
import type { LibraryAccessService } from "../library/access.ts";
import type { RoutinesService } from "../routines.ts";
import type { RunsService } from "../runs.ts";
import type { SkillsStoreService } from "../skills-store.ts";
import type { Principal } from "../workspaces.ts";
import {
  type AgentDraft,
  agentDraftSchema,
  type BuilderCatalog,
  reconcileDraft,
} from "./draft.ts";

const id = z.string().min(1).max(200);
const NO_SAMPLE_TEXT = "Run once on a sample, the way you would for real.";

/** The draft as the page keeps it. The row holds the fields only. */
export const saveDraftInputSchema = z.strictObject({
  draft: agentDraftSchema,
  draftAgentId: id.optional(),
});
export type SaveDraftInput = z.input<typeof saveDraftInputSchema>;

export const dryRunInputSchema = z.strictObject({
  draftAgentId: id,
  sample: agentDraftSchema.shape.sampleInput,
});
export type DryRunInput = z.input<typeof dryRunInputSchema>;

export const createInputSchema = z.strictObject({
  /** The local part to reserve. Without one, the slug's free suggestion is used. */
  address: id.optional(),
  draft: agentDraftSchema,
  draftAgentId: id,
});
export type CreateInput = z.input<typeof createInputSchema>;

export const discardInputSchema = z.strictObject({ draftAgentId: id });

/** The soul text each voice preset stands for. */
const VOICE_SOUL: Record<VoicePreset, string> = {
  brief: "Be brief. Lead with the answer and keep it short.",
  careful:
    "Be careful. Check your work, cite your sources and say what you are unsure of.",
  formal:
    "Be formal. Write in complete sentences and keep a professional tone.",
  friendly:
    "Be friendly and plain. Write the way you would talk to a colleague.",
};

/** The fields of the agent row a draft fills in. Rules join the instructions. */
const rowValues = (
  draft: AgentDraft
): {
  handsTo: string[];
  instructions: string;
  name: string;
  soul: string;
} => ({
  handsTo: draft.handsTo,
  instructions:
    draft.rules.length === 0
      ? draft.does
      : `${draft.does}\n\nRules:\n${draft.rules.map((rule) => `- ${rule}`).join("\n")}`,
  name: draft.name,
  soul: VOICE_SOUL[draft.voice],
});

const sampleText = (sample: AgentDraft["sampleInput"]): string =>
  sample.length === 0
    ? NO_SAMPLE_TEXT
    : sample.map((chip) => `${chip.key}: ${chip.value}`).join("\n");

interface Step {
  label: string;
  run: () => Promise<unknown>;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";

export interface LifecycleDeps {
  agents: Pick<
    AgentsService,
    | "activate"
    | "createDraft"
    | "discardDraft"
    | "get"
    | "reserveAddress"
    | "suggestAddress"
    | "update"
  >;
  catalog: (principal: Principal) => Promise<BuilderCatalog>;
  connectors: Pick<ConnectorsService, "assign">;
  libraryAccess: Pick<LibraryAccessService, "setGrant">;
  routines: Pick<RoutinesService, "create">;
  runs: Pick<RunsService, "startRun">;
  skillsStore: Pick<SkillsStoreService, "assign">;
  /** Refuses a principal that has no workspace to build in. */
  workspaceOf: (principal: Principal) => string;
}

export const createDraftLifecycle = ({
  agents,
  catalog,
  connectors,
  libraryAccess,
  routines,
  runs,
  skillsStore,
  workspaceOf,
}: LifecycleDeps) => {
  /** A draft the caller may build on. Anything else is not the builder's to touch. */
  const loadDraft = async (
    principal: Principal,
    agentId: string
  ): Promise<AgentRecord> => {
    workspaceOf(principal);
    const agent = await agents.get(principal, agentId);
    if (agent.status !== "draft") {
      throw new ServiceError("invalid", "That agent is not a draft");
    }
    return agent;
  };

  const saveDraft = async (
    principal: Principal,
    rawInput: SaveDraftInput
  ): Promise<AgentRecord> => {
    workspaceOf(principal);
    const { draft, draftAgentId } = saveDraftInputSchema.parse(rawInput);
    if (draftAgentId === undefined) {
      return await agents.createDraft(principal, rowValues(draft));
    }
    await loadDraft(principal, draftAgentId);
    return await agents.update(principal, draftAgentId, rowValues(draft));
  };

  const dryRun = async (
    principal: Principal,
    rawInput: DryRunInput
  ): Promise<{ runId: string; sessionId: string }> => {
    const { draftAgentId, sample } = dryRunInputSchema.parse(rawInput);
    await loadDraft(principal, draftAgentId);
    // The run is private to the builder, hidden from every list, and the cloud
    // runtime runs it whatever the draft's runtime is.
    const { runId, sessionId } = await runs.startRun(
      principal,
      {
        agentId: draftAgentId,
        input: { text: sampleText(sample) },
        session: { origin: "dry_run", private: true },
      },
      { dryRun: true }
    );
    return { runId, sessionId };
  };

  /** The open questions of a draft, checked against the workspace as it is now. */
  const openQuestions = async (
    principal: Principal,
    draft: AgentDraft
  ): Promise<string[]> => {
    const { gaps } = reconcileDraft(draft, await catalog(principal), draft);
    return gaps.map((gap) => gap.question);
  };

  /** The steps after activation, in the order the services allow. */
  const stepsFor = (
    principal: Principal,
    agent: AgentRecord,
    draft: AgentDraft,
    names: BuilderCatalog,
    address: string | undefined
  ): Step[] => {
    const agentId = agent.id;
    const nameOf = (
      list: { id: string; name: string }[],
      itemId: string
    ): string => list.find((item) => item.id === itemId)?.name ?? itemId;
    return [
      ...draft.tools.map((connectorId) => ({
        label: `Give it the ${nameOf(names.connectors, connectorId)} connector`,
        run: () => connectors.assign(principal, { agentId, connectorId }),
      })),
      ...draft.skills.map((skillId) => ({
        label: `Give it the ${nameOf(names.skills, skillId)} skill`,
        run: () => skillsStore.assign(principal, { agentId, skillId }),
      })),
      // The builder offers write access to a folder, as it always has.
      ...draft.library.map((path) => ({
        label: `Give it write access to ${path}`,
        run: () => libraryAccess.setGrant(principal, agentId, path, "write"),
      })),
      // A mail start creates nothing until V5, and a Slack mention needs no row.
      ...draft.startsOn.flatMap((start) =>
        start.kind === "routine"
          ? [
              {
                label: `Schedule ${start.label}`,
                run: () =>
                  routines.create(principal, {
                    agentId,
                    cron: start.cron,
                    name: start.label,
                    prompt: start.prompt,
                    ...(start.timezone === undefined
                      ? {}
                      : { timezone: start.timezone }),
                  }),
              },
            ]
          : []
      ),
      ...(agent.emailLocal === null
        ? [
            {
              label: "Reserve its address",
              run: async () =>
                await agents.reserveAddress(
                  principal,
                  agentId,
                  address ?? (await agents.suggestAddress(agent.slug))
                ),
            },
          ]
        : []),
    ];
  };

  /**
   * Runs the steps in order. The first failure stops the rest and is reported
   * with what landed and what did not, because the agent is already active
   * and the person finishes the rest on its profile.
   */
  const runSteps = async (agent: AgentRecord, steps: Step[]): Promise<void> => {
    const done: string[] = [];
    for (const [index, step] of steps.entries()) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: Each step needs the agent the earlier ones built.
        await step.run();
        done.push(step.label);
      } catch (error) {
        const notDone = steps.slice(index).map((left) => left.label);
        // biome-ignore lint/style/useErrorCause: ServiceError takes no cause, and its message already carries the original one.
        throw new ServiceError(
          isServiceError(error) ? error.code : "invalid",
          `${agent.name} is active, but "${step.label}" failed: ${describeError(error)}. Done: ${done.join("; ") || "nothing else"}. Not done: ${notDone.join("; ")}.`
        );
      }
    }
  };

  const create = async (
    principal: Principal,
    rawInput: CreateInput
  ): Promise<AgentRecord> => {
    const { address, draft, draftAgentId } = createInputSchema.parse(rawInput);
    await loadDraft(principal, draftAgentId);
    const questions = await openQuestions(principal, draft);
    if (questions.length > 0) {
      throw new ServiceError(
        "invalid",
        `Settle these first: ${questions.join("; ")}`
      );
    }
    const { runsOn } = draft;
    if (!runsOn) {
      throw new ServiceError("invalid", "Settle where it runs first");
    }
    // The row takes the draft's latest fields before it turns active.
    await agents.update(principal, draftAgentId, rowValues(draft));
    // Assignments, schedules and the address refuse an agent that is not active.
    const activated = await agents.activate(principal, draftAgentId, {
      // Only a machine agent takes a machine id.
      machineId: runsOn.runtime === "machine" ? runsOn.machineId : null,
      model: CLOUD_DEFAULT_MODEL,
      runtime: runsOn.runtime,
    });
    await runSteps(
      activated,
      stepsFor(principal, activated, draft, await catalog(principal), address)
    );
    return await agents.get(principal, draftAgentId);
  };

  const discard = async (
    principal: Principal,
    agentId: string
  ): Promise<AgentRecord> => {
    workspaceOf(principal);
    // Discarding twice is fine: an archived draft comes back as it is.
    return await agents.discardDraft(principal, agentId);
  };

  return { create, discard, dryRun, saveDraft };
};

export type DraftLifecycle = ReturnType<typeof createDraftLifecycle>;
