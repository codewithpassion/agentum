import { createClerkClient } from "@clerk/backend";
import type {
  LiveMentionPort,
  MentionEmail,
} from "@repo/services/live-artifacts/mentions";
import type { LiveRoomScope } from "@repo/services/live-artifacts/service";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import type { Composed } from "../compose";
import { emailMemberLookup } from "../mcp/clerk-email-member";
import { clerkOrgMemberCheckFresh } from "../mcp/clerk-membership";
import { freshMember } from "./auth";
import { requiredLive } from "./required";

const escapeHtml = (value: string) =>
  value.replaceAll(
    /[&<>"']/g,
    (c) =>
      ({ "'": "&#39;", '"': "&quot;", "&": "&amp;", "<": "&lt;", ">": "&gt;" })[
        c
      ] ?? c
  );

/** Uses the configured EMAIL binding. Tests supply a capture sender, never remote mail. */
export const mentionEmailAdapter = (
  sender: Pick<SendEmail, "send">,
  from: string,
  baseUrl: string
) => {
  const { origin } = new URL(baseUrl);
  return async (input: MentionEmail): Promise<void> => {
    const title = input.title.replaceAll(/[\r\n]/g, " ").slice(0, 120);
    const excerpt = input.excerpt.slice(0, 500);
    const url = `${origin}/a/${encodeURIComponent(input.artifactId)}#comment-${encodeURIComponent(input.threadId)}`;
    const text = `You were mentioned in ${title}.\n\n${excerpt}\n\n${url}`;
    await sender.send({
      from: { email: from, name: "Harbourmaster" },
      // A stable diagnostic header, not a claim of provider deduplication.
      headers: { "X-Harbourmaster-Delivery": input.deliveryId },
      html: `<p>You were mentioned in ${escapeHtml(title)}.</p><blockquote>${escapeHtml(excerpt)}</blockquote><p><a href="${escapeHtml(url)}">Open artifact</a></p>`,
      subject: `Mention in ${title}`,
      text,
      to: input.to,
    });
  };
};

export const productionMentionInfra = (
  env: Env,
  composed: () => Composed
): LiveMentionPort => {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  const lookup = emailMemberLookup({
    findUsers: async (email) =>
      (await clerk.users.getUserList({ emailAddress: [email], limit: 5 })).data,
    isOrgMember: clerkOrgMemberCheckFresh(env.CLERK_SECRET_KEY),
  });
  const recipient: LiveMentionPort["recipient"] = async (scope, userId) => {
    const principal = await freshMember(
      env,
      composed(),
      scope.workspaceId,
      userId
    );
    if (!principal) {
      return null;
    }
    const user = await clerk.users.getUser(userId);
    const address = user.emailAddresses.find(
      (item) =>
        item.id === user.primaryEmailAddressId &&
        item.verification?.status === "verified"
    );
    if (!address) {
      return null;
    }
    return {
      email: address.emailAddress,
      name:
        [user.firstName, user.lastName].filter(Boolean).join(" ") || "Member",
      principal,
    };
  };
  return {
    byEmail: async (scope: LiveRoomScope, email: string) => {
      const org = await requiredLive(composed().services).roomOrgId(
        SYSTEM_PRINCIPAL,
        scope.workspaceId
      );
      if (!org) {
        throw new Error("Workspace directory unavailable");
      }
      const userId = await lookup(email, org);
      return userId ? recipient(scope, userId) : null;
    },
    recipient,
    send: mentionEmailAdapter(
      env.EMAIL,
      `noreply@${env.MAIL_DOMAIN}`,
      env.PUBLIC_BASE_URL
    ),
  };
};
