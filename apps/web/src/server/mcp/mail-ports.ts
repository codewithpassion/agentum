// The `mail` group of the platform MCP tools: the calling run's own mailbox,
// over the mail service. Thread and message ids are the ids the service
// returns from `send` and `reply`, so an id from `mail_list` works in `mail_reply`.
import type { MailSendResult, McpPorts } from "@repo/mcp/ports";
import { ToolError } from "@repo/mcp/result";
import { MailError } from "@repo/services/mail/types";
import type { Principal } from "@repo/services/workspaces";
import { ZodError } from "zod";
import type { Services } from "../compose.ts";
import { guarded } from "./guarded.ts";

/** What a mail failure tells the agent: a rate limit and a refused send are things to wait out or change. */
const mailToolError = (error: unknown): unknown => {
  if (error instanceof MailError) {
    return new ToolError(
      error.code === "bad_request" ? "validation" : "conflict",
      error.message
    );
  }
  if (error instanceof ZodError) {
    return new ToolError("validation", "The mail draft is not valid.");
  }
  return error;
};

const mailGuarded = <T>(work: () => Promise<T>): Promise<T> =>
  guarded(async () => {
    try {
      return await work();
    } catch (error) {
      throw mailToolError(error);
    }
  });

/** A held mail is a normal result, kept apart from a sent one. The approval request stays internal. */
const toResult = (
  sent: Awaited<ReturnType<Services["mail"]["send"]>>
): MailSendResult =>
  sent.status === "sent"
    ? sent
    : { messageId: sent.messageId, status: "held", threadId: sent.threadId };

export const createMailPorts = ({
  principal,
  services,
}: {
  principal: Principal;
  services: Pick<Services, "mail">;
}): NonNullable<McpPorts["mail"]> => {
  const { mail } = services;
  return {
    list: (input) =>
      mailGuarded(() => mail.agent.listThreads(principal, input)),
    read: ({ threadId }) =>
      mailGuarded(() => mail.agent.readThread(principal, threadId)),
    reply: ({ threadId, ...draft }) =>
      mailGuarded(async () =>
        toResult(await mail.reply(principal, threadId, draft))
      ),
    send: (draft) =>
      mailGuarded(async () => toResult(await mail.send(principal, draft))),
  };
};
