import { findArtifact } from "@repo/db/artifacts";
import { agents } from "@repo/db/schema/agents";
import { artifactMembers } from "@repo/db/schema/live-artifacts";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import type { RoomTicketClaims } from "@repo/protocol/live";
import { and, eq, isNull, or } from "drizzle-orm";
import { agentCanSee, agentCanUpdate } from "../artifacts/policy.ts";
import { authorize, ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { Principal } from "../workspaces.ts";
import type { LiveArtifactsDeps, Member, Row } from "./service.ts";

type Role = RoomTicketClaims["role"];
const missing = () =>
  new ServiceError("not_found", "Artifact or checkpoint not found");
const readOnly = (member: Member) =>
  member.kind === "run"
    ? member.dryRun === true
    : member.apiKey?.access === "read" || member.oauthClient?.access === "read";

export const createLiveAccess = ({
  db,
  clock,
  scopedRunAccess,
}: Pick<LiveArtifactsDeps, "db" | "scopedRunAccess"> & {
  clock: Pick<LiveArtifactsDeps["clock"], "now">;
}) => {
  const now = () => clock.now().toISOString();
  const memberOf = (principal: Principal): Member => {
    if (principal.kind !== "user" && principal.kind !== "run") {
      throw new ForbiddenError("liveArtifacts");
    }
    if (!(principal.kind === "run" && principal.scopeArtifactId)) {
      authorize(principal, "liveArtifacts", {
        kind: "artifact",
        workspaceId: principal.workspaceId,
      });
    }
    return principal;
  };
  const runContext = async (member: Extract<Member, { kind: "run" }>) => {
    const [run] = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.id, member.runId),
          eq(runs.workspaceId, member.workspaceId),
          eq(runs.agentId, member.agentId)
        )
      )
      .limit(1);
    const [agent] = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.id, member.agentId),
          eq(agents.workspaceId, member.workspaceId)
        )
      )
      .limit(1);
    const [session] = run
      ? await db
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.id, run.sessionId),
              eq(sessions.workspaceId, member.workspaceId),
              or(
                eq(sessions.agentId, member.agentId),
                eq(sessions.origin, "artifact")
              )
            )
          )
          .limit(1)
      : [];
    if (!(run && agent && session)) {
      throw missing();
    }
    return { run, session };
  };
  const userRole = async (
    row: Row,
    userId: string,
    admin = false
  ): Promise<Role | null> => {
    if (admin || row.ownerUserId === userId) {
      return "owner";
    }
    const [grant] = await db
      .select()
      .from(artifactMembers)
      .where(
        and(
          eq(artifactMembers.workspaceId, row.workspaceId),
          eq(artifactMembers.artifactId, row.id),
          eq(artifactMembers.principalKind, "user"),
          eq(artifactMembers.userId, userId),
          isNull(artifactMembers.revokedAt)
        )
      )
      .limit(1);
    if (grant && (!grant.expiresAt || grant.expiresAt > now())) {
      return grant.role;
    }
    return row.audience === "workspace" ? "editor" : null;
  };
  const artifactRunRole = async (
    member: Extract<Member, { kind: "run" }>,
    row: Row,
    sourceId: string | null,
    askerId: string | null
  ): Promise<Role | null> => {
    if (!(sourceId && askerId)) {
      throw new ForbiddenError("liveArtifacts.scope");
    }
    const source = await findArtifact(db, member.workspaceId, sourceId);
    if (!source) {
      throw new ForbiddenError("liveArtifacts.scope");
    }
    const sourceRole = await userRole(source, askerId);
    const targetRole = await userRole(row, askerId);
    if (!(sourceRole && targetRole)) {
      throw new ForbiddenError("liveArtifacts.scope");
    }
    // Bound every target by the current asker and originating artifact rights.
    const roles: Role[] = [sourceRole, targetRole];
    if (sourceId !== row.id) {
      if (!agentCanSee(row, member.agentId)) {
        return null;
      }
      roles.push(agentCanUpdate(row, member.agentId) ? "editor" : "viewer");
    }
    if (roles.includes("viewer")) {
      return "viewer";
    }
    if (roles.includes("commenter")) {
      return "commenter";
    }
    return "editor";
  };
  const runRole = async (
    member: Extract<Member, { kind: "run" }>,
    row: Row
  ): Promise<Role | null> => {
    const { run, session } = await runContext(member);
    if (run.scopeArtifactId && run.scopeArtifactId !== row.id) {
      throw new ForbiddenError("liveArtifacts.scope");
    }
    if (run.scopeArtifactId) {
      if (!scopedRunAccess) {
        throw new ForbiddenError("liveArtifacts.scope");
      }
      return (await scopedRunAccess(member, row.id)).role;
    }
    if (session.origin === "artifact") {
      return await artifactRunRole(
        member,
        row,
        run.scopeArtifactId ?? session.externalKey,
        run.onBehalfOfUserId
      );
    }
    if (!agentCanSee(row, member.agentId)) {
      return null;
    }
    return agentCanUpdate(row, member.agentId) ? "editor" : "viewer";
  };
  const access = async (
    principal: Principal,
    artifactId: string,
    write = false,
    owner = false,
    live = true
  ) => {
    const member = memberOf(principal);
    const row = await findArtifact(db, member.workspaceId, artifactId);
    if (!row || (live && row.kind !== "document" && row.kind !== "deck")) {
      throw missing();
    }
    if (!(member.kind === "run" && member.scopeArtifactId)) {
      authorize(member, "liveArtifacts.access", {
        id: row.id,
        kind: "artifact",
        workspaceId: row.workspaceId,
      });
    }
    let role =
      member.kind === "user"
        ? await userRole(row, member.userId, member.isAdmin)
        : await runRole(member, row);
    if (!role) {
      throw missing();
    }
    if (readOnly(member)) {
      role = "viewer";
    }
    if (
      (write && role !== "editor" && role !== "owner") ||
      (owner && role !== "owner")
    ) {
      throw new ForbiddenError("liveArtifacts.write");
    }
    return { member, role, row };
  };
  return { access, memberOf, runContext };
};
