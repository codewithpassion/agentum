import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "#/db/client";
import type { Agent } from "#/modules/agents/schema";
import { getHostByIdUnscoped } from "#/modules/computer/hosts";
import { isChannelMember } from "#/modules/messaging/service";
import {
  requestTakeover,
  TAKEOVER_REASON_MAX_LENGTH,
} from "#/modules/questions/service";
import { rescheduleQuestionExpiry } from "#/modules/routines/scheduler";
import { fail, json } from "./format";
import { type McpToolContext, NOT_A_MEMBER } from "./tools";

/**
 * `request_human_takeover`: the agent asks a person to use its desktop for a
 * step only a person can do. Offered only where the agent has a desktop, so
 * `routes.ts` gates it with `agentHasDesktop`.
 */

/** Whether this agent has a desktop a person can take over. */
export const agentHasDesktop = async (
  db: Db,
  agent: Agent
): Promise<boolean> => {
  if (agent.runtime !== "managed" || !agent.computerHostId) {
    return false;
  }
  const host = await getHostByIdUnscoped(db, agent.computerHostId);
  return host?.capabilities?.desktop === true;
};

const TAKEOVER_NOTE =
  "A person has been asked to take over the desktop. End your turn now. You will get a message when they hand the desktop back.";

export const registerTakeoverTools = (
  server: McpServer,
  ctx: McpToolContext
): void => {
  server.registerTool(
    "request_human_takeover",
    {
      description:
        "Ask a person to take over your desktop for a step you cannot do yourself, such as a login, a CAPTCHA, or a code only they can see. Say in reason what they need to do. This posts the request in the channel and returns at once: end your turn after asking. When they hand the desktop back, you are woken with their note. Only one request can wait at a time.",
      inputSchema: {
        channelId: z
          .string()
          .describe("The channel to ask in - where the work is happening."),
        reason: z
          .string()
          .max(TAKEOVER_REASON_MAX_LENGTH)
          .describe(
            "What the person needs to do on the desktop, in plain words."
          ),
      },
      title: "Ask a person to take over the desktop",
    },
    async ({ channelId, reason }) => {
      const member = { memberId: ctx.agent.id, memberType: "agent" } as const;
      if (!(await isChannelMember(ctx.db, channelId, member))) {
        return fail(NOT_A_MEMBER);
      }

      const result = await requestTakeover(
        ctx.db,
        ctx.env,
        ctx.workspace,
        ctx.agent,
        { channelId, reason }
      );
      if (!result.ok) {
        return fail(result.reason);
      }
      // The workspace's timer is what closes a takeover nobody is watching.
      await rescheduleQuestionExpiry(ctx.env, ctx.workspace.id);

      return json({
        expiresAt: result.question.expiresAt?.toISOString() ?? null,
        messageId: result.message.id,
        note: TAKEOVER_NOTE,
        status: result.question.status,
        takeoverId: result.question.id,
      });
    }
  );
};
