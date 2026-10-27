import { createClerkClient } from "@clerk/backend";
import type {
  GuestEmailPort,
  InvitationEmail,
} from "@repo/services/live-guests/ports";
import { createLiveGuestsService } from "@repo/services/live-guests/service";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import type { Composed, ComposeEnv } from "../compose";
import { emailMemberLookup } from "../mcp/clerk-email-member";
import { clerkOrgMemberCheckFresh } from "../mcp/clerk-membership";

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "'": "&#39;", '"': "&quot;", "&": "&amp;", "<": "&lt;", ">": "&gt;" })[
        c
      ] ?? c
  );
export const guestEmailAdapter = (
  sender: Pick<SendEmail, "send">,
  from: string
): GuestEmailPort => {
  const send = async (
    input: InvitationEmail,
    subject: string,
    detail: string
  ) => {
    const text = `${input.inviterName} from ${input.workspaceName} shared ${input.artifactTitle} with you (${input.role}).\nExpires: ${input.expiresAt ?? "No expiry"}\n${detail}`;
    await sender.send({
      from: { email: from, name: "Harbourmaster" },
      html: `<p>${escapeHtml(text).replaceAll("\n", "<br>")}</p>`,
      subject,
      text,
      to: input.to,
    });
  };
  return {
    sendCode: (input) =>
      send(
        input,
        "Your Harbourmaster sign-in code",
        `${input.code}\nCode expires: ${input.codeExpiresAt}`
      ),
    sendInvitation: (input) =>
      send(input, "An artifact was shared with you", input.url),
  };
};

export interface GuestEnvironment {
  LIVE_GUESTS_OFF?: string;
}
export type GuestComposition = Pick<Composed, "atomic" | "clock" | "db"> & {
  services: Pick<Composed["services"], "events" | "liveArtifacts" | "runs">;
};
export const guestService = async (
  env: ComposeEnv & GuestEnvironment,
  composed: GuestComposition
) => {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  const live = composed.services.liveArtifacts;
  if (
    !(live && env.ARTIFACT_VIEW_KEY && env.PUBLIC_BASE_URL && env.MAIL_DOMAIN)
  ) {
    throw new Error("Guest access unavailable");
  }
  // Domain-separated private key material; no new environment secret required.
  const pepper = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`guest-otp-v1:${env.ARTIFACT_VIEW_KEY}`)
    )
  );
  const lookup = emailMemberLookup({
    findUsers: async (email) =>
      (await clerk.users.getUserList({ emailAddress: [email], limit: 5 })).data,
    isOrgMember: clerkOrgMemberCheckFresh(env.CLERK_SECRET_KEY),
  });
  return createLiveGuestsService({
    atomic: composed.atomic,
    clock: composed.clock,
    db: composed.db,
    directory: {
      findMemberByEmail: async ({ workspaceId, email }) => {
        const org = await live.roomOrgId(SYSTEM_PRINCIPAL, workspaceId);
        if (!org) {
          throw new Error("Workspace directory unavailable");
        }
        const userId = await lookup(email, org);
        if (!userId) {
          return null;
        }
        const user = await clerk.users.getUser(userId);
        return {
          displayName:
            [user.firstName, user.lastName].filter(Boolean).join(" ") ||
            "Member",
          userId,
        };
      },
    },
    email: guestEmailAdapter(env.EMAIL, `noreply@${env.MAIL_DOMAIN}`),
    events: composed.services.events,
    guestsOff: () => Boolean(env.LIVE_GUESTS_OFF),
    invalidations: {
      trigger: async () => {
        await env.LIVE_ARTIFACT_MAINTENANCE.getByName("maintenance").start();
        await live.retryInvalidations(SYSTEM_PRINCIPAL);
      },
    },
    inviterName: async ({ userId }) => {
      const user = await clerk.users.getUser(userId);
      return (
        [user.firstName, user.lastName].filter(Boolean).join(" ") ||
        user.username ||
        "Member"
      );
    },
    origin: new URL(env.PUBLIC_BASE_URL).origin,
    pepper,
    runs: composed.services.runs,
  });
};
