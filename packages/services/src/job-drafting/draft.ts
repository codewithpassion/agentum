import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { workspaces } from "@repo/db/schema/workspaces";
import type { ProposedTrigger } from "@repo/db/shared";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { authorize } from "../authz.ts";
import { requireWriter } from "../automation-access.ts";
import { CLOUD_DEFAULT_MODEL } from "../cloud/models.ts";
import type { Fetcher } from "../connectors/mcp.ts";
import { invalid, notFound } from "../errors.ts";
import { readableWorkspace } from "../guards.ts";
import { type ManagedKeysService, NO_KEY_MESSAGE } from "../managed/keys.ts";
import { isValidTimeZone, validateCron } from "../routines/cron.ts";
import type { Principal } from "../workspaces.ts";

const TOOL_NAME = "draft_job";
const FAILED_MESSAGE =
  "Could not draft this job. Try again, or describe the job differently.";
const NEEDS_WHEN_MESSAGE =
  "Say when it should run, for example every Friday at 9:00, or what should start it, like mail arriving.";

const replySchema = z.union([
  z.strictObject({ needsWhen: z.literal(true) }),
  z.strictObject({
    asksBefore: z.string().nullable(),
    cron: z.string().nullable(),
    deliversTo: z.string().nullable(),
    does: z.string().trim().min(1),
    source: z.enum(["routine", "http", "mail", "app"]),
    timezone: z.string().nullable(),
    when: z.string().trim().min(1),
  }),
]);

// A weekday without an hour is still a schedule: propose 09:00 for review.
// Explicit "when I ask" is an app event; missing timing must never imply app.
const SYSTEM_PROMPT = `You draft a job for an existing agent from a person's description.
Call the ${TOOL_NAME} tool exactly once and write nothing else.
If the description names no time or starting event, return needsWhen: true.
Use routine for schedules, http for web calls or webhooks, mail for arriving mail,
and app only for an explicit request such as "when I ask". Slack is not supported here.
For a routine write a five-field numeric cron. Use 09:00 if a day is given without an hour.
Interpret wall-clock times in the supplied workspace timezone unless the person names another IANA zone.
For other sources set cron and timezone to null.
Write when as a short description of the start and does as the work to perform, fitting the supplied agent's job.
Use asksBefore and deliversTo only when the person specifies them, otherwise null.
This is a draft for review; do not claim to have saved or run anything.`;

const reconcile = (
  result: ProposedTrigger,
  workspaceTimezone: string
): ProposedTrigger => {
  if (result.source !== "routine") {
    return { ...result, cron: null, timezone: null };
  }
  const timezone =
    result.timezone && isValidTimeZone(result.timezone)
      ? result.timezone
      : workspaceTimezone;
  return { ...result, timezone };
};

interface DraftingDeps {
  db: Database;
  fetch: Fetcher;
  managedKeys: Pick<ManagedKeysService, "resolve">;
}

export const createJobDrafter = ({
  db,
  fetch: fetcher,
  managedKeys,
}: DraftingDeps) => {
  const ask = async (apiKey: string, message: string): Promise<unknown> => {
    const response = await fetcher("https://api.anthropic.com/v1/messages", {
      body: JSON.stringify({
        max_tokens: 4096,
        messages: [{ content: message, role: "user" }],
        model: CLOUD_DEFAULT_MODEL,
        system: SYSTEM_PROMPT,
        // The default model rejects forced tools; the prompt requires this tool.
        tool_choice: { type: "auto" },
        tools: [
          {
            description: "Records a proposed job, or requests a time or event.",
            input_schema: {
              ...z.toJSONSchema(replySchema, { io: "input" }),
              // Both union branches are objects; Messages needs the root type.
              type: "object",
            },
            name: TOOL_NAME,
          },
        ],
      }),
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      method: "POST",
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as {
      content?: { type?: string; name?: string; input?: unknown }[];
    };
    return body.content?.find(
      (block) => block.type === "tool_use" && block.name === TOOL_NAME
    )?.input;
  };

  const draft = async (
    principal: Principal,
    agentId: string,
    text: string
  ): Promise<ProposedTrigger> => {
    const workspaceId = readableWorkspace(principal, "jobs.write");
    requireWriter(principal, "jobs.write");
    authorize(principal, "jobs.write", {
      id: agentId,
      kind: "jobs",
      workspaceId,
    });
    if (!text.trim() || text.length > 2000) {
      throw invalid("Describe the job in 1 to 2000 characters.");
    }
    const agent = await db
      .select({
        does: agents.instructions,
        name: agents.name,
      })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
      .get();
    if (!agent) {
      throw notFound("Agent not found");
    }
    const workspace = await db
      .select({ timezone: workspaces.timezone })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .get();
    if (!workspace) {
      throw notFound("Workspace not found");
    }
    const key = await managedKeys.resolve(workspaceId);
    if (!key) {
      throw invalid(NO_KEY_MESSAGE);
    }
    const message = `What the person wants:\n${text.trim()}\n\nAgent and workspace context:\n${JSON.stringify(
      {
        agent,
        timezone: workspace.timezone,
      }
    )}`;
    const attempt = async () => {
      try {
        const reply = replySchema.parse(await ask(key.apiKey, message));
        if (
          !("needsWhen" in reply) &&
          reply.source === "routine" &&
          (reply.cron === null || validateCron(reply.cron))
        ) {
          return null;
        }
        return reply;
      } catch {
        // Model and network errors may quote the key or personal text.
        return null;
      }
    };
    const result = (await attempt()) ?? (await attempt());
    if (!result) {
      throw invalid(FAILED_MESSAGE);
    }
    if ("needsWhen" in result) {
      throw invalid(NEEDS_WHEN_MESSAGE);
    }
    return reconcile(result, workspace.timezone);
  };
  return { draft };
};

export type JobDrafter = ReturnType<typeof createJobDrafter>;
