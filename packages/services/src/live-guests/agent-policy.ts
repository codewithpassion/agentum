import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { artifacts } from "@repo/db/schema/artifacts";
import { sessions } from "@repo/db/schema/sessions";
import type { GuestGrant } from "@repo/protocol/live";
import { and, eq, isNull } from "drizzle-orm";
import { guestUnavailable } from "../runs/guest-scope.ts";
/** Selection is read again inside RunsService's trusted start policy. */
export const guestAgentPolicy =
  (
    db: Database,
    ready: (model: string, workspaceId: string) => Promise<boolean>
  ) =>
  async (grant: GuestGrant, input: { agentId: string }) => {
    const [artifact] = await db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, grant.artifactId),
          eq(artifacts.workspaceId, grant.workspaceId),
          isNull(artifacts.deletedAt)
        )
      )
      .limit(1);
    const [session] = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.workspaceId, grant.workspaceId),
          eq(sessions.origin, "artifact"),
          eq(sessions.externalKey, grant.artifactId),
          eq(sessions.private, false)
        )
      )
      .limit(1);
    const selected =
      session?.agentId ?? artifact?.handedToAgentId ?? artifact?.agentId;
    const [agent] = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.id, input.agentId),
          eq(agents.workspaceId, grant.workspaceId),
          eq(agents.status, "active")
        )
      )
      .limit(1);
    if (
      !artifact ||
      selected !== input.agentId ||
      !agent ||
      !["cloud", "machine", "managed"].includes(agent.runtime) ||
      !(await ready(agent.model, grant.workspaceId))
    ) {
      throw guestUnavailable();
    }
  };
