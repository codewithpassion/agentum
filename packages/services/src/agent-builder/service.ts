/**
 * "Describe it in words and the builder drafts the profile." One Anthropic
 * Messages API call on the workspace's own key, with the workspace's connectors,
 * skills and agents as the only choices. The reply goes through `reconcileDraft`,
 * so a choice the model invented comes back as a gap, not as an id.
 *
 * Saving, dry-running, creating and discarding a draft live in `lifecycle.ts`.
 *
 * Drafting logs no event, because the agent does not exist yet. The description
 * and the key never reach an error message or a log line.
 */
import {
  AGENT_TEMPLATE_IDS,
  type ProfileGap,
  VOICE_PRESETS,
} from "@repo/db/shared";
import { z } from "zod";
import type { AgentsService } from "../agents.ts";
import { authorize, ForbiddenError } from "../authz.ts";
import { CLOUD_DEFAULT_MODEL } from "../cloud/models.ts";
import type { Fetcher } from "../connectors/mcp.ts";
import type { ConnectorsService } from "../connectors.ts";
import { ServiceError } from "../errors.ts";
import type { MachinesService } from "../machines.ts";
import { type ManagedKeysService, NO_KEY_MESSAGE } from "../managed/keys.ts";
import type { ModelKeysService } from "../model-keys.ts";
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
import { createDraftLifecycle, type LifecycleDeps } from "./lifecycle.ts";
import { templates } from "./templates.ts";

const ACTION = "agent_builder.draft";
const KIND = "agent_builder";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const TOOL_NAME = "draft_agent_profile";
const MAX_TOKENS = 16_000;
const DESCRIPTION_LIMIT = 8000;
const DOES_LIMIT = 200;
const FAILED_MESSAGE =
  "The builder could not draft a profile. Try again, or describe the agent differently.";

export const draftInputSchema = z.strictObject({
  description: z.string().trim().min(1).max(DESCRIPTION_LIMIT),
  locked: agentDraftSchema.partial().optional(),
  previous: agentDraftSchema.optional(),
  templateId: z.enum(AGENT_TEMPLATE_IDS).optional(),
  voicePreset: z.enum(VOICE_PRESETS).optional(),
});
export type DraftInput = z.input<typeof draftInputSchema>;

export interface DraftResult {
  didList: string[];
  draft: AgentDraft;
  gaps: ProfileGap[];
}

type Resolvable = Pick<ManagedKeysService, "resolve" | "status">;

export interface AgentBuilderDeps {
  agents: Pick<AgentsService, "list"> & LifecycleDeps["agents"];
  connectors: Pick<ConnectorsService, "list"> & LifecycleDeps["connectors"];
  fetch: Fetcher;
  libraryAccess: LifecycleDeps["libraryAccess"];
  machines: Pick<MachinesService, "list">;
  managedKeys: Resolvable;
  modelKeys: Pick<ModelKeysService, "status">;
  routines: Pick<RoutinesService, "create">;
  runs: Pick<RunsService, "startRun">;
  skillsStore: Pick<SkillsStoreService, "list"> & LifecycleDeps["skillsStore"];
}

/** The workspace of a person or run. The system principal has none and may not draft. */
const workspaceOf = (principal: Principal): string => {
  if (principal.kind === "system") {
    throw new ForbiddenError(ACTION);
  }
  authorize(principal, ACTION, {
    kind: KIND,
    workspaceId: principal.workspaceId,
  });
  return principal.workspaceId;
};

const messageFor = (
  input: z.output<typeof draftInputSchema>,
  catalog: BuilderCatalog
): string => {
  const parts = [`What the person wants:\n${input.description}`];
  if (input.templateId) {
    const template = templates[input.templateId];
    parts.push(
      `Starting point, the "${template.title}" template: ${template.description}`
    );
  }
  if (input.voicePreset) {
    parts.push(`Use the voice "${input.voicePreset}".`);
  }
  if (input.previous) {
    parts.push(
      `The previous draft, to refine:\n${JSON.stringify(input.previous)}`
    );
  }
  if (input.locked) {
    parts.push(
      `The person fixed these fields. Keep them as they are:\n${JSON.stringify(input.locked)}`
    );
  }
  parts.push(`The workspace's choices:\n${JSON.stringify(catalog)}`);
  return parts.join("\n\n");
};

const SYSTEM_PROMPT = `You draft the profile of an AI agent from a person's description.
Call the ${TOOL_NAME} tool exactly once with the draft, and write nothing else.
Pick connectors (tools), skills and agents (handsTo) only by the ids in the workspace's choices. When nothing fits, leave the list empty instead of inventing an id.
Pick runsOn only from the runtimes on offer, and a machineId only from the machines listed. When none fits, set runsOn to null.
Write a cron expression in five fields for any schedule, and a short label for it.
Keep the rules only in the rules field. The does text describes the work in prose and never holds a Rules: block.`;

interface MessagesResponse {
  content?: { input?: unknown; name?: string; type?: string }[];
}

/** Null when the reply holds no usable draft, which is worth a retry. */
const reconcileReply = (
  reply: unknown,
  catalog: BuilderCatalog,
  locked: Partial<AgentDraft> | undefined
): DraftResult | null => {
  const parsed = z.record(z.string(), z.unknown()).safeParse(reply);
  return parsed.success ? reconcileDraft(parsed.data, catalog, locked) : null;
};

export const createAgentBuilderService = ({
  agents,
  connectors,
  fetch: fetcher,
  libraryAccess,
  machines,
  managedKeys,
  modelKeys,
  routines,
  runs,
  skillsStore,
}: AgentBuilderDeps) => {
  const catalog = async (principal: Principal): Promise<BuilderCatalog> => {
    workspaceOf(principal);
    const [
      connectorList,
      skillList,
      agentList,
      machineList,
      anthropic,
      router,
    ] = await Promise.all([
      connectors.list(principal),
      skillsStore.list(principal),
      agents.list(principal),
      machines.list(principal),
      managedKeys.status(principal),
      modelKeys.status(principal, "openrouter"),
    ]);
    const usable = machineList.filter(
      (machine) =>
        machine.status !== "revoked" && machine.roles.includes("agent_host")
    );
    return {
      agents: agentList.map((agent) => ({
        does: agent.instructions.slice(0, DOES_LIMIT),
        id: agent.id,
        name: agent.name,
      })),
      connectors: connectorList.map((connector) => ({
        description: connector.url,
        id: connector.id,
        name: connector.name,
        tools: connector.tools.map((tool) => ({
          name: tool.name,
          readOnly: tool.readOnly,
        })),
      })),
      machines: usable.map((machine) => ({
        id: machine.id,
        name: machine.name,
        online: machine.status === "online",
      })),
      runtimes: [
        ...(usable.length > 0 ? ["machine" as const] : []),
        ...(anthropic.configured ? ["managed" as const] : []),
        ...(anthropic.configured || router.configured
          ? ["cloud" as const]
          : []),
      ],
      skills: skillList
        .filter((skill) => skill.ownerAgentId === null)
        .map((skill) => ({ description: "", id: skill.id, name: skill.name })),
    };
  };

  /** One model call. Returns the tool input, or null when the reply is unusable. */
  const ask = async (apiKey: string, user: string): Promise<unknown> => {
    // tool_choice stays "auto": the default model rejects a forced tool, and
    // the system prompt names the one tool to call.
    const response = await fetcher(ANTHROPIC_MESSAGES_URL, {
      body: JSON.stringify({
        max_tokens: MAX_TOKENS,
        messages: [{ content: user, role: "user" }],
        model: CLOUD_DEFAULT_MODEL,
        system: SYSTEM_PROMPT,
        tool_choice: { type: "auto" },
        tools: [
          {
            description: "Records the drafted agent profile.",
            input_schema: z.toJSONSchema(agentDraftSchema, { io: "input" }),
            name: TOOL_NAME,
          },
        ],
      }),
      headers: {
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      method: "POST",
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as MessagesResponse;
    return body.content?.find(
      (block) => block.type === "tool_use" && block.name === TOOL_NAME
    )?.input;
  };

  const draft = async (
    principal: Principal,
    rawInput: DraftInput
  ): Promise<DraftResult> => {
    const workspaceId = workspaceOf(principal);
    const input = draftInputSchema.parse(rawInput);
    const key = await managedKeys.resolve(workspaceId);
    if (!key) {
      throw new ServiceError("invalid", NO_KEY_MESSAGE);
    }
    const choices = await catalog(principal);
    const message = messageFor(input, choices);
    const attempt = async (): Promise<DraftResult | null> => {
      try {
        return reconcileReply(
          await ask(key.apiKey, message),
          choices,
          input.locked
        );
      } catch {
        // A malformed draft (ZodError) or a failed request. A network error can
        // quote the request, and so the key, so its words stay out.
        return null;
      }
    };
    // One retry: a model error and a malformed draft are both worth a second try.
    const result = (await attempt()) ?? (await attempt());
    if (result) {
      return result;
    }
    throw new ServiceError("invalid", FAILED_MESSAGE);
  };

  const lifecycle = createDraftLifecycle({
    agents,
    catalog,
    connectors,
    libraryAccess,
    routines,
    runs,
    skillsStore,
    workspaceOf,
  });

  return { catalog, draft, ...lifecycle };
};

export type AgentBuilderService = ReturnType<typeof createAgentBuilderService>;
