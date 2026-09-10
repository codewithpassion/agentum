import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logActivity } from "#/modules/activity/service";
import { absoluteUrl } from "#/modules/browser/service";
import {
  attachmentLinkPath,
  DEFAULT_LINK_TTL_SECONDS,
  MAX_LINK_TTL_SECONDS,
  signAttachmentLink,
} from "#/modules/messaging/attachment-links";
import { getAttachmentInWorkspace } from "#/modules/messaging/attachment-service";
import { fail, json } from "./format";
import type { McpToolContext } from "./tools";

/**
 * The one tool that turns a file in the workspace into something outside it can
 * read: a signed, expiring URL to a single attachment.
 *
 * It exists for the case `http_request` cannot cover - an API that will not take
 * bytes in the request body and insists on fetching the file itself, which is
 * how most transcription and OCR services work. The agent hands that URL over in
 * the request body it composes; the service fetches it once and it stops working.
 *
 * The workspace check is here rather than at the route: `getAttachmentInWorkspace`
 * is what proves this agent's workspace can see the file, and after that the
 * signature is the credential (see routes/attachment-links.ts).
 */

const MILLISECONDS_PER_SECOND = 1000;

export interface AttachmentLinkArgs {
  attachmentId: string;
  ttlSeconds?: number;
}

/**
 * Says nothing about whether the id exists elsewhere, for the same reason
 * `list_secrets`' miss does: a message that told "no such attachment" apart from
 * "another workspace's attachment" would enumerate the deployment.
 */
const noSuchAttachment = (id: string): string =>
  `No attachment with id ${id} is readable from your workspace. Attachment ids come from the \`attachments\` field of read_channel, read_thread and search_messages results.`;

export const attachmentLink = async (
  ctx: McpToolContext,
  args: AttachmentLinkArgs
): Promise<CallToolResult> => {
  const attachment = await getAttachmentInWorkspace(
    ctx.db,
    ctx.workspace.id,
    args.attachmentId
  );
  if (!attachment) {
    return fail(noSuchAttachment(args.attachmentId));
  }

  let link: Awaited<ReturnType<typeof signAttachmentLink>>;
  try {
    link = await signAttachmentLink(ctx.env.ATTACHMENT_LINK_KEY, {
      id: attachment.id,
      ttlSeconds: args.ttlSeconds,
    });
  } catch (error) {
    // A deployment with no key is a configuration fault the agent cannot fix,
    // but it can stop trying and say what is wrong in the channel - so the
    // sentence goes back as a tool error rather than an unhandled throw.
    return fail(error instanceof Error ? error.message : String(error));
  }

  const expiresAt = new Date(
    link.expiresAt * MILLISECONDS_PER_SECOND
  ).toISOString();

  // Minting one of these publishes a private file to anyone who holds the URL,
  // which is exactly the kind of thing an owner needs to be able to find after
  // the fact. The signature is never recorded: the row is an audit trail, not a
  // second copy of the credential.
  await logActivity(ctx.db, {
    agentId: ctx.agent.id,
    detail: {
      attachmentId: attachment.id,
      expiresAt,
      filename: attachment.filename,
      mime: attachment.mime,
    },
    kind: "attachment.link",
    summary: `Shared ${attachment.filename} by signed link until ${expiresAt}`,
  });

  return json({
    expiresAt,
    filename: attachment.filename,
    mime: attachment.mime,
    size: attachment.size,
    // Absolute, and PUBLIC_APP_URL first: the caller is a service on the
    // internet, and the request origin an MCP call arrived on is not always one
    // - the Cloudflare runtime connects to this server in memory.
    url: absoluteUrl(
      ctx.env.PUBLIC_APP_URL,
      ctx.requestUrl,
      attachmentLinkPath(link)
    ),
  });
};

export const registerAttachmentTools = (
  server: McpServer,
  ctx: McpToolContext
): void => {
  server.registerTool(
    "attachment_link",
    {
      description: `Turn an attachment in your workspace into a temporary public URL, for handing a file to an external API that has to fetch it itself - a transcription or OCR service that takes a URL rather than bytes. Anyone holding the URL can download that one file until it expires (${DEFAULT_LINK_TTL_SECONDS / 60} minutes by default, at most ${MAX_LINK_TTL_SECONDS / 60}), so mint it when you are about to make the call, not in advance, and do not post it in a channel. Attachment ids come from the \`attachments\` field of read_channel, read_thread and search_messages results.`,
      inputSchema: {
        attachmentId: z.string(),
        ttlSeconds: z
          .number()
          .int()
          .optional()
          .describe(
            `How long the URL should work for, in seconds (default ${DEFAULT_LINK_TTL_SECONDS}, max ${MAX_LINK_TTL_SECONDS}). Anything longer is capped.`
          ),
      },
      title: "Get a temporary URL for an attachment",
    },
    (args) => attachmentLink(ctx, args)
  );
};
