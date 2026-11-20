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

// One flat object: the Messages API refuses a union at the root of a tool schema.
const replySchema = z.strictObject({
  asksBefore: z.string().nullish(),
  cron: z.string().nullish(),
  deliversTo: z.string().nullish(),
  does: z.string().trim().nullish(),
  source: z.enum(["routine", "http", "mail", "needs_when"]),
  timezone: z.string().nullish(),
  when: z.string().trim().nullish(),
});
type Reply = z.output<typeof replySchema>;

// A weekday without an hour is still a schedule: propose 09:00 for review.
// The spec drafts a routine, a mail or an http trigger. Text with no time or event,
// "when I ask" included, comes back as needs_when and is rejected.
const SYSTEM_PROMPT = `You draft a job for an existing agent from a person's description.
Call the ${TOOL_NAME} tool exactly once and write nothing else.
If the description names no time or starting event, return source needs_when and leave the other fields null.
Use routine for schedules, http for web calls or webhooks, and mail for arriving mail.
Slack and "when I ask" are not supported here, so those also get needs_when.
For a routine write a five-field numeric cron. Use 09:00 if a day is given without an hour.
Interpret wall-clock times in the supplied workspace timezone unless the person names another IANA zone.
For other sources set cron and timezone to null.
Write when as a short description of the start and does as the work to perform, fitting the supplied agent's job.
Use asksBefore and deliversTo only when the person specifies them, otherwise null.
This is a draft for review; do not claim to have saved or run anything.`;

const reconcile = (
  reply: Reply,
  workspaceTimezone: string
): ProposedTrigger => {
  const { source } = reply;
  if (source === "needs_when") {
    throw invalid(NEEDS_WHEN_MESSAGE);
  }
  const base = {
    asksBefore: reply.asksBefore ?? null,
    deliversTo: reply.deliversTo ?? null,
    does: reply.does ?? "",
    source,
    when: reply.when ?? "",
  };
  if (source !== "routine") {
    return { ...base, cron: null, timezone: null };
  }
  return {
    ...base,
    cron: reply.cron ?? null,
    timezone:
      reply.timezone && isValidTimeZone(reply.timezone)
        ? reply.timezone
        : workspaceTimezone,
  };
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
    const attempt = async (): Promise<Reply | null> => {
      try {
        const reply = replySchema.parse(await ask(key.apiKey, message));
        if (reply.source === "needs_when") {
          return reply;
        }
        const complete = Boolean(reply.does && reply.when);
        const cronFails =
          reply.source === "routine" &&
          (!reply.cron || validateCron(reply.cron) !== null);
        return complete && !cronFails ? reply : null;
      } catch {
        // Model and network errors may quote the key or personal text.
        return null;
      }
    };
    const result = (await attempt()) ?? (await attempt());
    if (!result) {
      throw invalid(FAILED_MESSAGE);
    }
    return reconcile(result, workspace.timezone);
  };
  return { draft };
};

export type JobDrafter = ReturnType<typeof createJobDrafter>;
