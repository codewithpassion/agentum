/**
 * Opens, link shares and the access log of artifacts (PRD section 6, A.3).
 *
 * A member opens through `open` and gets a view token for one version. A link
 * viewer is not a `Principal`: `openLink` resolves the token to a `ShareGrant`
 * that only artifact code takes. No token, view or share, is ever written to a
 * row, an event or a log. A share token is stored as a hash plus an AES-GCM
 * copy, and a view token only lives in the URL this service returns.
 */
import type { Database } from "@repo/db";
import {
  type ArtifactAccessRow,
  type ArtifactShareRow,
  type ArtifactVersionRef,
  bumpShareOpenStatement,
  ensureViewSalt,
  getLinkSwitch,
  getLiveArtifact,
  getShareByHash,
  getShareById,
  getVersionById,
  getVersionByNumber,
  insertShareStatement,
  insertViewStatement,
  listShares,
  listViews,
  type NewArtifactView,
  pruneViewSalts,
  pruneViews,
  revokeShareStatement,
  setLinkSwitchStatement,
} from "@repo/db/artifact-shares";
import type { Atomic } from "@repo/db/atomic";
import { ARTIFACT_VIEW_KEEP_DAYS } from "@repo/db/shared";
import {
  ARTIFACT_SHARE_TOKEN_PREFIX,
  type ArtifactShare,
  type ArtifactsCreateShareInput,
  type ArtifactsOpenInput,
  type ArtifactsOpenOutput,
  type ArtifactsSetLinksEnabledInput,
  type ArtifactsSharesInput,
  type ArtifactsViewsInput,
  type ArtifactsViewsOutput,
  artifactContentPath,
  artifactsCreateShareInputSchema,
  artifactsOpenInputSchema,
  artifactsSetLinksEnabledInputSchema,
  artifactsSharesInputSchema,
  artifactsViewsInputSchema,
  type ShareOpenResponse,
  type ViewTokenClaims,
} from "@repo/protocol/artifacts";
import { ulid } from "ulidx";
import { authorize, ForbiddenError } from "../authz.ts";
import {
  decryptSecret,
  encryptSecret,
  hashedToken,
  hashToken,
  type SecretBinding,
} from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import type { EventsService, PeopleLookup } from "../events.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import { agentCanSee, canManage, canOpen, type PolicyUser } from "./policy.ts";
import {
  cutUserAgent,
  newSalt,
  referrerHost,
  truncateIp,
  utcDay,
  visitorHash,
} from "./view-privacy.ts";
import { signViewToken } from "./view-token.ts";

/** A member's view token lives this long (PRD R1.29: nothing outlives an hour). */
const MEMBER_TOKEN_SECONDS = 60 * 60;
/** A link viewer's view token lives this long, or until the link expires. */
const LINK_TOKEN_SECONDS = 60 * 60;
/** The `artifact_test` token lives 5 minutes. */
const TEST_TOKEN_SECONDS = 5 * 60;
/** Views pages hold this many rows. */
const VIEWS_PAGE_SIZE = 50;
/** Salts older than this many days are deleted. */
const SALT_KEEP_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

const SHARE_TABLE = "artifact_shares";
const SHARE_TOKEN_FIELD = "token";

const ARTIFACT_KIND = "artifact";
const OPEN_ACTION = "artifacts.open";
const TEST_ACTION = "artifacts.test";
const SHARES_ACTION = "artifacts.shares";
const CREATE_SHARE_ACTION = "artifacts.createShare";
const REVOKE_SHARE_ACTION = "artifacts.revokeShare";
const VIEWS_ACTION = "artifacts.views";
const SWITCH_ACTION = "artifacts.setLinksEnabled";

type UserPrincipal = Extract<Principal, { kind: "user" }>;
type RunPrincipal = Extract<Principal, { kind: "run" }>;

/**
 * What a link token grants: one version of one artifact in one workspace.
 * It is not a `Principal` and `can()` never sees it. The `kind` tag keeps the
 * type apart from every principal, so only code that names `ShareGrant`
 * accepts it.
 */
export interface ShareGrant {
  readonly artifactId: string;
  readonly kind: "share_grant";
  readonly shareId: string;
  readonly versionId: string;
  readonly workspaceId: string;
}

/** What the HTTP route reads off the request. The service never sees `Request`. */
export interface ShareRequestInfo {
  /** `request.cf`, when present. */
  cf?: {
    asn?: number | string | null;
    asOrganization?: string | null;
    city?: string | null;
    country?: string | null;
    region?: string | null;
  } | null;
  /** `CF-Connecting-IP`. Used to hash and to truncate, never stored. */
  ip: string | null;
  /** The `Referer` header. Only its host is stored. */
  referrer: string | null;
  userAgent: string | null;
}

export type LinkOpenResult =
  | { grant: ShareGrant; ok: true; response: ShareOpenResponse }
  | { ok: false };

export interface ArtifactSharesDeps {
  atomic: Atomic;
  clock: Pick<Clock, "now">;
  db: Database;
  events: Pick<EventsService, "insertStatement">;
  /** `ARTIFACT_LINKS_OFF` set on the environment: every link open is refused. */
  linksOff?: boolean;
  /** Origin that share URLs start with, for example `https://app.example`. */
  origin: string;
  /** Names for the owner shown on the share page. */
  people?: PeopleLookup;
  /** The key behind `SECRETS_KEY`. */
  secretsKey: CryptoKey;
  /** `ARTIFACT_VIEW_KEY`: signs view tokens. */
  viewKey: string;
}

const requireUser = (principal: Principal, action: string): UserPrincipal => {
  if (principal.kind !== "user") {
    throw new ForbiddenError(action);
  }
  return principal;
};

/** Link management is for a signed-in person, not for an API key or an agent. */
const requireSessionUser = (
  principal: Principal,
  action: string
): UserPrincipal => {
  const user = requireUser(principal, action);
  if (user.via !== "session") {
    throw new ForbiddenError(action);
  }
  return user;
};

const policyUser = (user: UserPrincipal): PolicyUser => ({
  isAdmin: user.isAdmin === true,
  userId: user.userId,
});

const notFound = () => new ServiceError("not_found", "Artifact not found");

const shareStatus = (
  share: Pick<ArtifactShareRow, "expiresAt" | "revokedAt">,
  now: Date
): ArtifactShare["status"] => {
  if (share.revokedAt) {
    return "revoked";
  }
  if (share.expiresAt && Date.parse(share.expiresAt) <= now.getTime()) {
    return "expired";
  }
  return "active";
};

const parseLiveTools = (text: string | null): string[] | null => {
  if (text === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed)
    ? parsed.filter((tool): tool is string => typeof tool === "string")
    : null;
};

/** Why a known link refuses, or `ok`. Revoked wins over expired, expired over disabled. */
const linkOutcome = (
  share: {
    artifactDeletedAt: string | null;
    expiresAt: string | null;
    linksEnabled: boolean;
    revokedAt: string | null;
  },
  hasVersion: boolean,
  now: Date,
  linksOff: boolean
): NewArtifactView["outcome"] => {
  if (share.revokedAt || share.artifactDeletedAt || !hasVersion) {
    return "revoked";
  }
  if (share.expiresAt && Date.parse(share.expiresAt) <= now.getTime()) {
    return "expired";
  }
  return linksOff || !share.linksEnabled ? "disabled" : "ok";
};

export const createArtifactSharesService = ({
  atomic,
  clock,
  db,
  events,
  linksOff = false,
  origin,
  people,
  secretsKey,
  viewKey,
}: ArtifactSharesDeps) => {
  const shareBinding = (workspaceId: string, rowId: string): SecretBinding => ({
    field: SHARE_TOKEN_FIELD,
    rowId,
    table: SHARE_TABLE,
    workspaceId,
  });

  const toShare = async (
    row: ArtifactShareRow,
    now: Date
  ): Promise<ArtifactShare> => {
    const token = await decryptSecret(
      secretsKey,
      shareBinding(row.workspaceId, row.id),
      row.tokenEncrypted
    );
    return {
      artifactId: row.artifactId,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      dataMode: row.dataMode,
      expiresAt: row.expiresAt,
      grantedBy: row.grantedBy,
      id: row.id,
      lastOpenedAt: row.lastOpenedAt,
      liveTools: parseLiveTools(row.liveTools),
      openCount: row.openCount,
      revokedAt: row.revokedAt,
      status: shareStatus(row, now),
      url: `${origin}/s/${token}`,
      versionId: row.versionId,
    };
  };

  /** The artifact when the member may open it; missing and hidden look the same. */
  const openableArtifact = async (
    user: UserPrincipal,
    action: string,
    artifactId: string
  ): Promise<ArtifactAccessRow> => {
    const artifact = await getLiveArtifact(db, user.workspaceId, artifactId);
    if (!(artifact && canOpen(artifact, policyUser(user)))) {
      throw notFound();
    }
    authorize(user, action, {
      id: artifact.id,
      kind: ARTIFACT_KIND,
      workspaceId: artifact.workspaceId,
    });
    return artifact;
  };

  /** The artifact when the member may manage its links. */
  const managedArtifact = async (
    user: UserPrincipal,
    action: string,
    artifactId: string
  ): Promise<ArtifactAccessRow> => {
    const artifact = await openableArtifact(user, action, artifactId);
    if (!canManage(artifact, policyUser(user))) {
      throw new ForbiddenError(action);
    }
    return artifact;
  };

  const sign = (
    claims: Omit<ViewTokenClaims, "expiresAt">,
    seconds: number
  ) => {
    const expiresAt = Math.floor(clock.now().getTime() / 1000) + seconds;
    return signViewToken({ ...claims, expiresAt }, viewKey).then((token) => ({
      contentUrl: artifactContentPath({ artifactId: claims.artifactId, token }),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    }));
  };

  /** Resolves the version a member asks for: the number, else the current one. */
  const resolveVersion = async (
    artifact: ArtifactAccessRow,
    number: number | undefined
  ): Promise<ArtifactVersionRef> => {
    let version: ArtifactVersionRef | undefined;
    if (number === undefined) {
      version = artifact.currentVersionId
        ? await getVersionById(db, artifact.id, artifact.currentVersionId)
        : undefined;
    } else {
      version = await getVersionByNumber(db, artifact.id, number);
    }
    if (version?.status !== "published") {
      throw new ServiceError("not_found", "Version not found");
    }
    return version;
  };

  /**
   * A member opens an artifact: audience check, one view row, and a content
   * URL with a 1 hour view token.
   */
  const open = async (
    principal: Principal,
    input: ArtifactsOpenInput
  ): Promise<ArtifactsOpenOutput> => {
    const user = requireUser(principal, OPEN_ACTION);
    const {
      artifactId,
      surface,
      version: number,
    } = artifactsOpenInputSchema.parse(input);
    const artifact = await openableArtifact(user, OPEN_ACTION, artifactId);
    const version = await resolveVersion(artifact, number);
    await atomic([
      insertViewStatement(db, {
        artifactId,
        createdAt: clock.now().toISOString(),
        id: ulid(clock.now().getTime()),
        outcome: "ok",
        surface,
        userId: user.userId,
        versionId: version.id,
        workspaceId: user.workspaceId,
      }),
    ]);
    const signed = await sign(
      {
        artifactId,
        userId: user.userId,
        versionId: version.id,
        viewer: "member",
      },
      MEMBER_TOKEN_SECONDS
    );
    return {
      contentUrl: signed.contentUrl,
      expiresAt: signed.expiresAt,
      version: { createdAt: version.createdAt, number: version.number },
    };
  };

  /**
   * The Browser Run token of `artifact_test`: 5 minutes, for a run whose agent
   * may see the artifact, with a view row of surface `test`.
   */
  const mintTestToken = async (
    principal: Principal,
    input: { artifactId: string; versionId: string }
  ): Promise<{ contentUrl: string; expiresAt: string }> => {
    if (principal.kind !== "run") {
      throw new ForbiddenError(TEST_ACTION);
    }
    const run: RunPrincipal = principal;
    const artifact = await getLiveArtifact(
      db,
      run.workspaceId,
      input.artifactId
    );
    if (!(artifact && agentCanSee(artifact, run.agentId))) {
      throw notFound();
    }
    authorize(run, TEST_ACTION, {
      id: artifact.id,
      kind: ARTIFACT_KIND,
      workspaceId: artifact.workspaceId,
    });
    const version = await getVersionById(db, artifact.id, input.versionId);
    if (!version) {
      throw new ServiceError("not_found", "Version not found");
    }
    await atomic([
      insertViewStatement(db, {
        artifactId: artifact.id,
        createdAt: clock.now().toISOString(),
        id: ulid(clock.now().getTime()),
        outcome: "ok",
        surface: "test",
        versionId: version.id,
        workspaceId: run.workspaceId,
      }),
    ]);
    return await sign(
      { artifactId: artifact.id, versionId: version.id, viewer: "test" },
      TEST_TOKEN_SECONDS
    );
  };

  /** The links of an artifact the member may open, with copyable URLs. */
  const shares = async (
    principal: Principal,
    input: ArtifactsSharesInput
  ): Promise<ArtifactShare[]> => {
    const user = requireUser(principal, SHARES_ACTION);
    const { artifactId } = artifactsSharesInputSchema.parse(input);
    await openableArtifact(user, SHARES_ACTION, artifactId);
    const rows = await listShares(db, user.workspaceId, artifactId);
    const now = clock.now();
    return await Promise.all(rows.map((row) => toShare(row, now)));
  };

  /** A new snapshot link. Live links are phase 2 and refused here. */
  const createShare = async (
    principal: Principal,
    input: ArtifactsCreateShareInput
  ): Promise<ArtifactShare> => {
    const user = requireSessionUser(principal, CREATE_SHARE_ACTION);
    const parsed = artifactsCreateShareInputSchema.parse(input);
    const artifact = await managedArtifact(
      user,
      CREATE_SHARE_ACTION,
      parsed.artifactId
    );
    if (parsed.dataMode !== "snapshot") {
      throw new ServiceError("invalid", "Live links are not available yet.");
    }
    if (linksOff || !(await getLinkSwitch(db, user.workspaceId))) {
      throw new ServiceError(
        "invalid",
        "Link sharing is turned off for this workspace."
      );
    }
    const now = clock.now();
    const expiresAt = parsed.expiresAt
      ? new Date(parsed.expiresAt).toISOString()
      : null;
    if (expiresAt !== null && Date.parse(expiresAt) <= now.getTime()) {
      throw new ServiceError("invalid", "The expiry must be in the future.");
    }
    const versionId = parsed.versionId ?? null;
    if (versionId !== null) {
      const version = await getVersionById(db, artifact.id, versionId);
      if (version?.status !== "published") {
        throw new ServiceError("not_found", "Version not found");
      }
    }
    const id = ulid(now.getTime());
    const { hash, token } = await hashedToken(ARTIFACT_SHARE_TOKEN_PREFIX);
    const row: ArtifactShareRow = {
      artifactId: artifact.id,
      createdAt: now.toISOString(),
      createdBy: user.userId,
      dataMode: "snapshot",
      expiresAt,
      grantedBy: null,
      id,
      kind: "link",
      lastOpenedAt: null,
      liveTools: null,
      openCount: 0,
      revokedAt: null,
      revokedBy: null,
      tokenEncrypted: await encryptSecret(
        secretsKey,
        shareBinding(user.workspaceId, id),
        token
      ),
      tokenHash: hash,
      versionId,
      workspaceId: user.workspaceId,
    };
    await atomic([
      insertShareStatement(db, row),
      events.insertStatement({
        actor: { id: user.userId, kind: "user" },
        payload: { artifactId: artifact.id, expiresAt, shareId: id, versionId },
        type: "artifact.share_created",
        workspaceId: user.workspaceId,
      }),
    ]);
    return { ...(await toShare(row, now)), url: `${origin}/s/${token}` };
  };

  /** Revokes a link. A link that is already revoked keeps its first revocation. */
  const revokeShare = async (
    principal: Principal,
    input: { shareId: string }
  ): Promise<void> => {
    const user = requireSessionUser(principal, REVOKE_SHARE_ACTION);
    const share = await getShareById(db, user.workspaceId, input.shareId);
    if (!share) {
      throw new ServiceError("not_found", "Link not found");
    }
    await managedArtifact(user, REVOKE_SHARE_ACTION, share.artifactId);
    if (share.revokedAt) {
      return;
    }
    const now = clock.now().toISOString();
    await atomic([
      revokeShareStatement(db, share.id, now, user.userId),
      events.insertStatement({
        actor: { id: user.userId, kind: "user" },
        payload: { artifactId: share.artifactId, shareId: share.id },
        type: "artifact.share_revoked",
        workspaceId: user.workspaceId,
      }),
    ]);
  };

  /** One page of the access log of an artifact, for its owner and admins. */
  const views = async (
    principal: Principal,
    input: ArtifactsViewsInput
  ): Promise<ArtifactsViewsOutput> => {
    const user = requireUser(principal, VIEWS_ACTION);
    const { artifactId, cursor, shareId } =
      artifactsViewsInputSchema.parse(input);
    await managedArtifact(user, VIEWS_ACTION, artifactId);
    const rows = await listViews(db, {
      artifactId,
      before: cursor,
      limit: VIEWS_PAGE_SIZE + 1,
      shareId,
      workspaceId: user.workspaceId,
    });
    const items = rows.slice(0, VIEWS_PAGE_SIZE);
    const last = items.at(-1);
    return rows.length > VIEWS_PAGE_SIZE && last
      ? { items, next: last.id }
      : { items };
  };

  /** The workspace switch for link sharing. Admins only. */
  const setLinksEnabled = async (
    principal: Principal,
    input: ArtifactsSetLinksEnabledInput
  ): Promise<void> => {
    const user = requireSessionUser(principal, SWITCH_ACTION);
    const { enabled } = artifactsSetLinksEnabledInputSchema.parse(input);
    authorize(user, SWITCH_ACTION, {
      kind: "workspace",
      workspaceId: user.workspaceId,
    });
    if (user.isAdmin !== true) {
      throw new ForbiddenError(SWITCH_ACTION);
    }
    await atomic([
      setLinkSwitchStatement(db, user.workspaceId, enabled),
      events.insertStatement({
        actor: { id: user.userId, kind: "user" },
        payload: { enabled },
        type: "artifact.links_switched",
        workspaceId: user.workspaceId,
      }),
    ]);
  };

  /** The version a link shows: its pin, else the artifact's current one. */
  const linkVersion = async (share: {
    artifactId: string;
    currentVersionId: string | null;
    versionId: string | null;
  }): Promise<ArtifactVersionRef | undefined> => {
    const versionId = share.versionId ?? share.currentVersionId;
    return versionId
      ? await getVersionById(db, share.artifactId, versionId)
      : undefined;
  };

  const ownerName = async (userId: string | null): Promise<string | null> => {
    if (!(userId && people)) {
      return null;
    }
    try {
      const person = (await people([userId])).get(userId);
      return person?.name?.trim() || person?.email?.trim() || null;
    } catch (error) {
      console.error("People lookup failed", error);
      return null;
    }
  };

  /**
   * The row for a link open. The full IP goes into the hash and the prefix
   * only; the row keeps neither the address nor the token.
   */
  const viewRow = async (
    share: { artifactId: string; shareId: string; workspaceId: string },
    versionId: string | null,
    outcome: NewArtifactView["outcome"],
    request: ShareRequestInfo,
    now: Date
  ): Promise<NewArtifactView> => {
    const userAgent = cutUserAgent(request.userAgent);
    let hash: string | null = null;
    if (request.ip) {
      const salt = await ensureViewSalt(
        db,
        share.workspaceId,
        utcDay(now),
        newSalt()
      );
      hash = await visitorHash(salt, request.ip, request.userAgent ?? "");
    }
    const cf = request.cf ?? {};
    const text = (value: string | null | undefined) => value || null;
    return {
      artifactId: share.artifactId,
      asn: cf.asn === null || cf.asn === undefined ? null : String(cf.asn),
      asOrg: text(cf.asOrganization),
      city: text(cf.city),
      country: text(cf.country),
      createdAt: now.toISOString(),
      id: ulid(now.getTime()),
      ipPrefix: request.ip ? truncateIp(request.ip) : null,
      outcome,
      referrerHost: referrerHost(request.referrer),
      region: text(cf.region),
      shareId: share.shareId,
      surface: "share",
      userAgent,
      versionId,
      visitorHash: hash,
      workspaceId: share.workspaceId,
    };
  };

  /**
   * A link opens. The token is looked up by its hash. Unknown, revoked,
   * expired and disabled links all answer `{ ok: false }`, and the route turns
   * that into one 404. Every known link writes a view row with its outcome.
   */
  const openLink = async (
    token: string,
    request: ShareRequestInfo
  ): Promise<LinkOpenResult> => {
    if (!token.startsWith(ARTIFACT_SHARE_TOKEN_PREFIX)) {
      return { ok: false };
    }
    const share = await getShareByHash(db, await hashToken(token));
    if (!share) {
      return { ok: false };
    }
    const now = clock.now();
    const version = await linkVersion(share);
    const outcome = linkOutcome(share, version !== undefined, now, linksOff);
    const writes = [
      insertViewStatement(
        db,
        await viewRow(share, version ? version.id : null, outcome, request, now)
      ),
    ];
    if (outcome === "ok") {
      writes.push(bumpShareOpenStatement(db, share.shareId, now.toISOString()));
    }
    await atomic(writes);
    if (outcome !== "ok" || !version) {
      return { ok: false };
    }
    const expiresAtShare = share.expiresAt
      ? Math.floor(Date.parse(share.expiresAt) / 1000)
      : Number.POSITIVE_INFINITY;
    const seconds = Math.min(
      LINK_TOKEN_SECONDS,
      expiresAtShare - Math.floor(now.getTime() / 1000)
    );
    const signed = await sign(
      {
        artifactId: share.artifactId,
        shareId: share.shareId,
        versionId: version.id,
        viewer: "link",
      },
      seconds
    );
    const owner = await ownerName(share.ownerUserId);
    return {
      grant: {
        artifactId: share.artifactId,
        kind: "share_grant",
        shareId: share.shareId,
        versionId: version.id,
        workspaceId: share.workspaceId,
      },
      ok: true,
      response: {
        agentName: share.agentName,
        contentUrl: signed.contentUrl,
        expiresAt: signed.expiresAt,
        kind: share.kind,
        ownerName: owner,
        title: share.title,
        version: { createdAt: version.createdAt, number: version.number },
        workspaceName: share.workspaceName,
      },
    };
  };

  /**
   * Deletes access-log rows past `ARTIFACT_VIEW_KEEP_DAYS` and salts past two
   * days (R1.33). The minute tick calls it; it takes no principal.
   */
  const prune = async (): Promise<void> => {
    const now = clock.now();
    await pruneViews(
      db,
      new Date(now.getTime() - ARTIFACT_VIEW_KEEP_DAYS * DAY_MS).toISOString()
    );
    await pruneViewSalts(
      db,
      utcDay(new Date(now.getTime() - SALT_KEEP_DAYS * DAY_MS))
    );
  };

  return {
    createShare,
    mintTestToken,
    open,
    openLink,
    prune,
    revokeShare,
    setLinksEnabled,
    shares,
    views,
  };
};

export type ArtifactSharesService = ReturnType<
  typeof createArtifactSharesService
>;
