import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { guestMemberMutation } from "@repo/db/live-guests";
import { artifacts } from "@repo/db/schema/artifacts";
import {
  artifactMembers,
  guestIdentities,
  guestInvites,
} from "@repo/db/schema/live-artifacts";
import { workspaces } from "@repo/db/schema/workspaces";
import type { ArtifactMemberRole } from "@repo/db/shared";
import { and, eq, isNull } from "drizzle-orm";
import { ulid } from "ulidx";
import { authorize, ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { EventsService } from "../events.ts";
import { roomInvalidationStatement } from "../live-artifacts/access-lifecycle.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import type {
  GuestDirectoryPort,
  GuestEmailPort,
  GuestInvalidationDeliveryPort,
} from "./ports.ts";
import { newInvitationToken } from "./security.ts";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(["viewer", "commenter", "editor"]);
const missing = () => new ServiceError("not_found", "Invitation unavailable");
type User = Extract<Principal, { kind: "user" }>;

export const createGuestInvitations = (deps: {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  directory: GuestDirectoryPort;
  email: GuestEmailPort;
  events: Pick<EventsService, "insertStatement">;
  guestsOff: () => boolean;
  /** Public HTTPS platform origin, from trusted configuration. */
  origin: string;
  /** Trusted profile lookup; do not let clients claim another inviter's name. */
  inviterName: (user: User) => Promise<string>;
  invalidations: GuestInvalidationDeliveryPort;
}) => {
  const { db, atomic, clock } = deps;
  const origin = new URL(deps.origin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  ) {
    throw new Error("Guest invitation origin must be an HTTPS origin");
  }
  const now = () => clock.now().toISOString();
  const owner = async (principal: Principal, artifactId: string) => {
    if (
      principal.kind !== "user" ||
      principal.apiKey?.access === "read" ||
      principal.oauthClient?.access === "read"
    ) {
      throw new ForbiddenError("guestInvitations");
    }
    authorize(principal, "guestInvitations", {
      kind: "artifact",
      workspaceId: principal.workspaceId,
    });
    const [row] = await db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, artifactId),
          eq(artifacts.workspaceId, principal.workspaceId),
          isNull(artifacts.deletedAt)
        )
      )
      .limit(1);
    if (
      !(row && ["document", "deck"].includes(row.kind)) ||
      (!principal.isAdmin && row.ownerUserId !== principal.userId)
    ) {
      throw missing();
    }
    return { row, user: principal };
  };
  const roleOf = (role: ArtifactMemberRole) => {
    if (!ROLES.has(role)) {
      throw new ServiceError("invalid", "Invalid invitation role");
    }
    return role;
  };
  const event = (
    user: User,
    type:
      | "artifact.guest_invited"
      | "artifact.member_added"
      | "artifact.member_role_changed"
      | "artifact.member_revoked",
    payload: Record<string, unknown>
  ) =>
    deps.events.insertStatement({
      actor: { id: user.userId, kind: "user" },
      payload,
      type,
      workspaceId: user.workspaceId,
    });
  const member = async (
    principal: Principal,
    artifactId: string,
    memberId: string
  ) => {
    const context = await owner(principal, artifactId);
    const [grant] = await db
      .select()
      .from(artifactMembers)
      .where(
        and(
          eq(artifactMembers.id, memberId),
          eq(artifactMembers.artifactId, artifactId),
          eq(artifactMembers.workspaceId, context.user.workspaceId)
        )
      )
      .limit(1);
    if (!grant) {
      throw missing();
    }
    if (grant.guestId) {
      const [identity] = await db
        .select({ id: guestIdentities.id })
        .from(guestIdentities)
        .where(
          and(
            eq(guestIdentities.id, grant.guestId),
            eq(guestIdentities.workspaceId, context.user.workspaceId)
          )
        )
        .limit(1);
      if (!identity) {
        throw missing();
      }
    }
    return { ...context, grant };
  };
  const validate = (input: {
    email: string;
    expiresAt?: string;
    agentRunsPerDay?: number;
  }) => {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
      throw new ServiceError("invalid", "Invalid email address");
    }
    const cap = input.agentRunsPerDay ?? 20;
    if (!Number.isSafeInteger(cap) || cap < 0) {
      throw new ServiceError("invalid", "Invalid daily agent cap");
    }
    const expiresAt =
      input.expiresAt === undefined ? null : new Date(input.expiresAt);
    if (
      expiresAt &&
      (!Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() <= clock.now().getTime())
    ) {
      throw new ServiceError("invalid", "Expiry must be in the future");
    }
    return { cap, email, expiresAt };
  };
  const prepareGuest = async (
    email: string,
    workspaceId: string,
    createdAt: string,
    statements: Statement[]
  ) => {
    const [identity] = await db
      .select()
      .from(guestIdentities)
      .where(
        and(
          eq(guestIdentities.workspaceId, workspaceId),
          eq(guestIdentities.email, email)
        )
      )
      .limit(1);
    const guestId = identity?.id ?? ulid();
    if (!identity) {
      statements.push(
        db.insert(guestIdentities).values({
          createdAt,
          displayName: email,
          email,
          id: guestId,
          workspaceId,
        })
      );
    }
    return guestId;
  };
  const replaceGrant = async (
    user: User,
    artifactId: string,
    identity: { guestId: string | null; userId: string | null },
    statements: Statement[],
    createdAt: string
  ) => {
    const [previous] = await db
      .select()
      .from(artifactMembers)
      .where(
        and(
          eq(artifactMembers.workspaceId, user.workspaceId),
          eq(artifactMembers.artifactId, artifactId),
          identity.guestId
            ? eq(artifactMembers.guestId, identity.guestId)
            : eq(artifactMembers.userId, identity.userId ?? ""),
          isNull(artifactMembers.revokedAt)
        )
      )
      .limit(1);
    if (!previous) {
      return false;
    }
    // Rotate credentials by replacing the grant, retaining old invitation/audit
    // history. The CAS and new unique grant are committed in one batch.
    statements.push(
      guestMemberMutation(db, {
        before: previous,
        revokedAt: createdAt,
        revokedBy: user.userId,
        role: previous.role,
      }),
      event(user, "artifact.member_revoked", {
        artifactId,
        memberId: previous.id,
      }),
      roomInvalidationStatement(
        deps,
        { artifactId, workspaceId: user.workspaceId },
        previous.guestId ? `g:${previous.guestId}` : `u:${previous.userId}`
      )
    );
    return true;
  };
  const checkWorkspace = async (
    workspaceId: string,
    isNamed: boolean,
    expiresAt: Date | null
  ) => {
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (
      !workspace ||
      (!isNamed && (deps.guestsOff() || !workspace.liveGuestsEnabled))
    ) {
      throw missing();
    }
    if (!(isNamed || expiresAt)) {
      throw new ServiceError("invalid", "Guest expiry is required");
    }
    return workspace;
  };
  return {
    async changeRole(
      principal: Principal,
      input: { artifactId: string; memberId: string; role: ArtifactMemberRole }
    ) {
      const role = roleOf(input.role);
      const { user, row, grant } = await member(
        principal,
        input.artifactId,
        input.memberId
      );
      if (grant.revokedAt || (grant.expiresAt && grant.expiresAt <= now())) {
        throw missing();
      }
      if (grant.role === role) {
        return;
      }
      await atomic([
        guestMemberMutation(db, { before: grant, role }),
        event(user, "artifact.member_role_changed", {
          artifactId: row.id,
          memberId: grant.id,
          role,
        }),
        roomInvalidationStatement(
          deps,
          { artifactId: row.id, workspaceId: user.workspaceId },
          grant.guestId ? `g:${grant.guestId}` : `u:${grant.userId}`
        ),
      ]);
      await deps.invalidations.trigger();
    },
    async invite(
      principal: Principal,
      input: {
        artifactId: string;
        email: string;
        role: ArtifactMemberRole;
        expiresAt?: string;
        agentRunsPerDay?: number;
      }
    ) {
      const { row, user } = await owner(principal, input.artifactId);
      const role = roleOf(input.role);
      const { email, cap, expiresAt } = validate(input);
      // Never convert directory failures into outsider grants.
      const named = await deps.directory.findMemberByEmail({
        email,
        workspaceId: user.workspaceId,
      });
      const workspace = await checkWorkspace(
        user.workspaceId,
        named !== null,
        expiresAt
      );
      const expiry = expiresAt?.toISOString() ?? null;
      const principalKind = named ? ("user" as const) : ("guest" as const);
      const createdAt = now();
      const memberId = ulid();
      const statements: Statement[] = [];
      const guestId = named
        ? null
        : await prepareGuest(email, user.workspaceId, createdAt, statements);
      const replaced = await replaceGrant(
        user,
        row.id,
        { guestId, userId: named ? named.userId : null },
        statements,
        createdAt
      );
      statements.push(
        db.insert(artifactMembers).values({
          agentRunsPerDay: cap,
          artifactId: row.id,
          createdAt,
          createdBy: user.userId,
          expiresAt: expiry,
          guestId,
          id: memberId,
          principalKind,
          role,
          userId: named ? named.userId : null,
          workspaceId: user.workspaceId,
        })
      );
      const invitation = named ? null : await newInvitationToken();
      if (invitation) {
        statements.push(
          db.insert(guestInvites).values({
            createdAt,
            id: ulid(),
            memberId,
            tokenHash: invitation.hash,
            workspaceId: user.workspaceId,
          })
        );
      }
      statements.push(
        event(
          user,
          named ? "artifact.member_added" : "artifact.guest_invited",
          {
            artifactId: row.id,
            expiresAt: expiry,
            memberId,
            role,
          }
        )
      );
      const inviterName = await deps.inviterName(user);
      await atomic(statements);
      if (replaced) {
        await deps.invalidations.trigger();
      }
      // Explicit sender failure propagates; never claim delivery succeeded.
      await deps.email.sendInvitation({
        artifactTitle: row.title,
        expiresAt: expiry,
        inviterName,
        role,
        to: email,
        url: new URL(
          invitation ? `/g/${invitation.token}` : `/a/${row.id}`,
          origin
        ).href,
        workspaceName: workspace.name,
      });
      return {
        memberId,
        principalKind,
      };
    },
    async revoke(
      principal: Principal,
      input: { artifactId: string; memberId: string }
    ) {
      const { user, row, grant } = await member(
        principal,
        input.artifactId,
        input.memberId
      );
      if (grant.revokedAt) {
        return;
      }
      await atomic([
        guestMemberMutation(db, {
          before: grant,
          revokedAt: now(),
          revokedBy: user.userId,
          role: grant.role,
        }),
        event(user, "artifact.member_revoked", {
          artifactId: row.id,
          memberId: grant.id,
        }),
        roomInvalidationStatement(
          deps,
          { artifactId: row.id, workspaceId: user.workspaceId },
          grant.guestId ? `g:${grant.guestId}` : `u:${grant.userId}`
        ),
      ]);
      await deps.invalidations.trigger();
    },
  };
};
