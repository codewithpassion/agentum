import { artifactGrants, artifacts } from "@repo/db/schema/artifacts";
import { triggers } from "@repo/db/schema/triggers";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { INPUT_TEXT_MAX } from "../runs/types.ts";
import type { TriggersService } from "../triggers.ts";
/**
 * What an app artifact's server code may reach, read from its version's grants
 * (phase 2). Hosts and secret names come from `artifact_grants`; the secret
 * values come from the workspace secrets service, by name.
 */

import type { Database } from "@repo/db";
import {
  approvedGrantTargets,
  hasGrantOfKind,
  versionWorkspaceId,
  workspaceClerkOrgId,
} from "@repo/db/artifact-app";
import type { ProxyMatch, SecretsService } from "../secrets.ts";
import type { Principal } from "../workspaces.ts";

export interface AppGrantsDeps {
  db: Database;
  fire?: TriggersService["fire"];
  /** Whether a user is in a Clerk org right now, with no cache. Without it, no member call runs. */
  isOrgMember?: (userId: string, clerkOrgId: string) => Promise<boolean>;
  secrets: Pick<SecretsService, "proxyForNames">;
}

export const createAppGrantsService = ({
  db,
  fire,
  isOrgMember,
  secrets,
}: AppGrantsDeps) => {
  /** The hosts a person approved for the version. */
  const approvedHosts = (versionId: string): Promise<string[]> =>
    approvedGrantTargets(db, { kind: "host", versionId });

  /** Whether the version asked for any host, approved or not. */
  const declaresHosts = (versionId: string): Promise<boolean> =>
    hasGrantOfKind(db, { kind: "host", versionId });

  /** The header rules of the version's approved secrets that apply to `host`. */
  const secretRules = async (
    workspaceId: string,
    versionId: string,
    host: string
  ): Promise<ProxyMatch[]> => {
    const names = await approvedGrantTargets(db, {
      kind: "secret",
      versionId,
    });
    if (names.length === 0) {
      return [];
    }
    return await secrets.proxyForNames(workspaceId, names, host);
  };

  /**
   * The user principal for a member whose page or app server calls a tool.
   * The view token is minutes old, so membership is asked again, uncached:
   * null when the workspace has no row, or the
   * person has left the org. Admin rights are not carried, so a private
   * artifact of someone else stays closed to an admin's app calls.
   */
  const memberPrincipal = async (
    userId: string,
    workspaceId: string
  ): Promise<Extract<Principal, { kind: "user" }> | null> => {
    const clerkOrgId = await workspaceClerkOrgId(db, workspaceId);
    if (
      !(clerkOrgId && isOrgMember && (await isOrgMember(userId, clerkOrgId)))
    ) {
      return null;
    }
    return { kind: "user", userId, via: "session", workspaceId };
  };

  const startRun = async (
    props: { artifactId: string; versionId: string; workspaceId: string },
    raw: { agent: string; text: string; state?: string; sessionKey?: string }
  ): Promise<{ runId: string }> => {
    const input = z
      .strictObject({
        agent: z.string().min(1).max(200),
        sessionKey: z.string().min(1).max(200).optional(),
        state: z.string().max(4096).default(""),
        text: z.string().min(1).max(INPUT_TEXT_MAX),
      })
      .parse(raw);
    const [grant] = await db
      .select({ id: artifactGrants.id })
      .from(artifacts)
      .innerJoin(
        artifactGrants,
        eq(artifactGrants.versionId, artifacts.currentVersionId)
      )
      .where(
        and(
          eq(artifacts.id, props.artifactId),
          eq(artifacts.workspaceId, props.workspaceId),
          eq(artifacts.currentVersionId, props.versionId),
          eq(artifactGrants.kind, "agent"),
          eq(artifactGrants.target, input.agent),
          eq(artifactGrants.status, "approved")
        )
      )
      .limit(1);
    if (!grant) {
      throw new Error(
        "not_granted: the live version has no approved agent grant"
      );
    }
    const [trigger] = await db
      .select()
      .from(triggers)
      .where(
        and(
          eq(triggers.artifactId, props.artifactId),
          eq(triggers.agentId, input.agent),
          eq(triggers.workspaceId, props.workspaceId),
          eq(triggers.kind, "app"),
          isNull(triggers.disabledAt),
          isNull(triggers.revokedAt)
        )
      )
      .limit(1);
    if (!(trigger && fire)) {
      throw new Error("forbidden: app trigger is unavailable");
    }
    const { run } = await fire(
      {
        agentId: trigger.agentId,
        kind: "trigger",
        triggerId: trigger.id,
        workspaceId: trigger.workspaceId,
      },
      trigger.id,
      { text: input.text },
      { sessionKey: input.sessionKey, state: input.state }
    );
    return { runId: run.id };
  };

  return {
    approvedHosts,
    declaresHosts,
    memberPrincipal,
    secretRules,
    startRun,
    versionWorkspaceId: (
      artifactId: string,
      versionId: string
    ): Promise<string | null> =>
      versionWorkspaceId(db, { artifactId, versionId }),
  };
};

export type AppGrantsService = ReturnType<typeof createAppGrantsService>;
