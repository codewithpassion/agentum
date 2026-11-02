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
import { approvedToolTargets } from "@repo/db/artifact-calls";
import {
  type ArtifactAccessRow,
  type ArtifactShareRow,
  type ArtifactVersionRef,
  bumpShareOpenStatement,
  countLiveCalls,
  ensureViewSalt,
  getLinkSwitch,
  getLiveArtifact,
  getShareByHash,
  getShareById,
  getShareLookupById,
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
  setViewOutcomeStatement,
} from "@repo/db/artifact-shares";
import type { Atomic } from "@repo/db/atomic";
import { ARTIFACT_VIEW_KEEP_DAYS } from "@repo/db/shared";
import {
  ARTIFACT_SHARE_TOKEN_PREFIX,
  type ArtifactShare,
  type ArtifactsCreateShareInput,
  type ArtifactsOpenInput,
  type ArtifactsOpenOutput,
  type ArtifactsRevokeShareInput,
  type ArtifactsSetLinksEnabledInput,
  type ArtifactsSharesInput,
  type ArtifactsViewsInput,
  type ArtifactsViewsOutput,
  artifactContentPath,
  artifactsCreateShareInputSchema,
  artifactsOpenInputSchema,
  artifactsRevokeShareInputSchema,
  artifactsSetLinksEnabledInputSchema,
  artifactsSharesInputSchema,
  artifactsViewsInputSchema,
  type ShareCallInput,
  type ShareOpenResponse,
  type ShareStorageInput,
  shareCallInputSchema,
  shareStorageInputSchema,
  type ViewTokenClaims,
} from "@repo/protocol/artifacts";
import { ulid } from "ulidx";
import { authorize, ForbiddenError } from "../authz.ts";
import {
  decryptSecret,
  encryptSecret,
  hashedToken,
  hashToken,
  importSecretsKey,
  type SecretBinding,
} from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import type { EventsService, PeopleLookup } from "../events.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import { checkToolLimits } from "./arg-limits.ts";
import { isArtifactCallError, type ToolRunner } from "./calls.ts";
import {
  agentCanSee,
  canCreateLiveLink,
  canManage,
  canOpen,
  type PolicyUser,
} from "./policy.ts";
import { type AppStorePort, LIST_LIMIT } from "./storage.ts";
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
const MINUTE_MS = 60 * 1000;

/** Live call limits (PRD R2.13): per link a minute and a day, per visitor a minute. */
export const LIVE_CALLS_PER_LINK_MINUTE = 60;
export const LIVE_CALLS_PER_LINK_DAY = 1000;
export const LIVE_CALLS_PER_VISITOR_MINUTE = 10;
/** Marks a limits row (`<tool>#<json>`) among a version's tool grants. */
const LIMITS_SEPARATOR = "#";

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
const LINKS_ENABLED_ACTION = "artifacts.linksEnabled";

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

/** What a link viewer's storage request comes to. Reads only, in the shared area. */
export type LinkStorageResult =
  | { ok: true; result: { keys: string[] } | { value: unknown } }
  | { ok: false; reason: "not_found" | "forbidden" | "failed" };

/** What a link viewer's tool call comes to. The route maps the reasons to 404, 403, 429 and 502. */
/** What the access log keeps of a visitor (R1.33). */
export interface VisitorMeta {
  ipPrefix: string | null;
  place: string | null;
  userAgent: string | null;
  visitorHash: string | null;
}

export type ShareState =
  | { dataMode: "snapshot" | "live"; ok: true }
  | { ok: false; reason: "revoked" | "expired" | "disabled" | "unknown" };

export type LinkCallResult =
  | { ok: true; result: unknown }
  | {
      ok: false;
      reason: "not_found" | "forbidden" | "rate_limited" | "failed";
    };

export type LinkOpenResult =
  | { grant: ShareGrant; ok: true; response: ShareOpenResponse }
  | { ok: false };

export interface ArtifactSharesDeps {
  atomic: Atomic;
  clock: Pick<Clock, "now">;
  db: Database;
  events: Pick<EventsService, "insertStatement">;
  /**
   * Whether `userId` belongs to the Clerk org right now, with no cache. Live
   * link calls ask it for `granted_by` on every call (R2.11). Without it, no
   * live call runs.
   */
  isOrgMember?: (userId: string, clerkOrgId: string) => Promise<boolean>;
  /** `ARTIFACT_LINKS_OFF` set on the environment: every link open is refused. */
  linksOff?: boolean;
  /** Origin that share URLs start with, for example `https://app.example`. */
  origin: string;
  /** Names for the owner shown on the share page. */
  people?: PeopleLookup;
  /** Runs a granted tool as a person (B.5). Without it, no live call runs. */
  runner?: ToolRunner;
  /** `SECRETS_KEY`, base64. Needed to create or show a link. */
  secretsKey?: string;
  /** App storage, read by link viewers through `storageLink`. Without it, those reads fail. */
  store?: Pick<AppStorePort, "get" | "list">;
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

/** What a log line may say of a failed call: the code or the type, never the upstream text. */
const errorLabel = (error: unknown): string =>
  isArtifactCallError(error)
    ? error.code
    : (error instanceof Error && error.name) || "unknown";

/** A stored value as the bridge gives it: parsed JSON, or the raw text an app server wrote. */
const storedValue = (text: string | null): unknown => {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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
  isOrgMember,
  linksOff = false,
  origin,
  people,
  runner,
  secretsKey,
  store,
  viewKey,
}: ArtifactSharesDeps) => {
  let importedKey: Promise<CryptoKey> | undefined;
  const cryptoKey = (): Promise<CryptoKey> => {
    if (!secretsKey) {
      throw new Error("Link shares need secretsKey (SECRETS_KEY).");
    }
    importedKey ??= importSecretsKey(secretsKey);
    return importedKey;
  };

  const shareBinding = (workspaceId: string, rowId: string): SecretBinding => ({
    field: SHARE_TOKEN_FIELD,
    rowId,
    table: SHARE_TABLE,
    workspaceId,
  });

  /**
   * The share as the API shows it. `showUrl` false (a member who may not
   * manage links) leaves the token out: the URL is `<origin>/s/` and nothing
   * is decrypted, so the bearer secret stays with the owner and admins.
   */
  const toShare = async (
    row: ArtifactShareRow,
    now: Date,
    showUrl: boolean
  ): Promise<ArtifactShare> => {
    const token = showUrl
      ? await decryptSecret(
          await cryptoKey(),
          shareBinding(row.workspaceId, row.id),
          row.tokenEncrypted
        )
      : "";
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
    if (!viewKey) {
      throw new ServiceError("invalid", "Artifact viewing is not set up.");
    }
    const expiresAt = Math.floor(clock.now().getTime() / 1000) + seconds;
    return signViewToken({ ...claims, expiresAt }, viewKey).then((token) => ({
      contentUrl: artifactContentPath({ artifactId: claims.artifactId, token }),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    }));
  };

  /**
   * Resolves the version a member asks for: the number, else the current one.
   * Someone who manages the artifact may also open a proposed version, to
   * look at it before promoting it.
   */
  const resolveVersion = async (
    artifact: ArtifactAccessRow,
    number: number | undefined,
    mayOpenProposed: boolean
  ): Promise<ArtifactVersionRef> => {
    let version: ArtifactVersionRef | undefined;
    if (number === undefined) {
      version = artifact.currentVersionId
        ? await getVersionById(db, artifact.id, artifact.currentVersionId)
        : undefined;
    } else {
      version = await getVersionByNumber(db, artifact.id, number);
    }
    const openable =
      version?.status === "published" ||
      (mayOpenProposed && version?.status === "proposed");
    if (!(version && openable)) {
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
    const user = requireSessionUser(principal, OPEN_ACTION);
    const {
      artifactId,
      surface,
      version: number,
    } = artifactsOpenInputSchema.parse(input);
    const artifact = await openableArtifact(user, OPEN_ACTION, artifactId);
    const version = await resolveVersion(
      artifact,
      number,
      canManage(artifact, policyUser(user))
    );
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
    // A proposed version is unreviewed agent code: it opens as a test viewer,
    // which reads shared data and writes and calls nothing, whoever looks.
    const signed = await sign(
      version.status === "proposed"
        ? {
            artifactId,
            versionId: version.id,
            viewer: "test",
            workspaceId: user.workspaceId,
          }
        : {
            artifactId,
            userId: user.userId,
            versionId: version.id,
            viewer: "member",
            workspaceId: user.workspaceId,
          },
      MEMBER_TOKEN_SECONDS
    );
    return {
      contentUrl: signed.contentUrl,
      expiresAt: signed.expiresAt,
      ...(version.status === "proposed" && { preview: true }),
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
      {
        artifactId: artifact.id,
        versionId: version.id,
        viewer: "test",
        workspaceId: run.workspaceId,
      },
      TEST_TOKEN_SECONDS
    );
  };

  /**
   * The links of an artifact the member may open. Only the owner and admins
   * get copyable URLs; other members see the links without the token.
   */
  const shares = async (
    principal: Principal,
    input: ArtifactsSharesInput
  ): Promise<ArtifactShare[]> => {
    const user = requireSessionUser(principal, SHARES_ACTION);
    const { artifactId } = artifactsSharesInputSchema.parse(input);
    const artifact = await openableArtifact(user, SHARES_ACTION, artifactId);
    const showUrl = canManage(artifact, policyUser(user));
    const rows = await listShares(db, user.workspaceId, artifactId);
    const now = clock.now();
    return await Promise.all(rows.map((row) => toShare(row, now, showUrl)));
  };

  /** The plain tool keys a version has approved. Limits rows (`<tool>#<json>`) are not tools. */
  const approvedTools = async (
    workspaceId: string,
    versionId: string
  ): Promise<string[]> =>
    (await approvedToolTargets(db, { versionId, workspaceId })).filter(
      (target) => !target.includes(LIMITS_SEPARATOR)
    );

  /** The expiry (in the future) and the pinned version (published) a new link asks for. */
  const checkedShareOptions = async (
    artifact: ArtifactAccessRow,
    wanted: { expiresAt?: string | null; versionId?: string | null },
    now: Date
  ): Promise<{ expiresAt: string | null; versionId: string | null }> => {
    const expiresAt = wanted.expiresAt
      ? new Date(wanted.expiresAt).toISOString()
      : null;
    if (expiresAt !== null && Date.parse(expiresAt) <= now.getTime()) {
      throw new ServiceError("invalid", "The expiry must be in the future.");
    }
    const versionId = wanted.versionId ?? null;
    if (versionId !== null) {
      const version = await getVersionById(db, artifact.id, versionId);
      if (version?.status !== "published") {
        throw new ServiceError("not_found", "Version not found");
      }
    }
    return { expiresAt, versionId };
  };

  /**
   * The tools a live link may call: each must be approved for the version the
   * link will show, its pin or else the current one.
   */
  const checkedLiveTools = async (
    artifact: ArtifactAccessRow,
    versionId: string | null,
    requested: string[]
  ): Promise<string[]> => {
    const tools = [...new Set(requested)];
    const shown = await linkVersion({
      artifactId: artifact.id,
      currentVersionId: artifact.currentVersionId,
      versionId,
    });
    const approved = shown
      ? await approvedTools(artifact.workspaceId, shown.id)
      : [];
    if (!tools.every((tool) => approved.includes(tool))) {
      throw new ServiceError(
        "invalid",
        "A live link can only call tools this version has approved."
      );
    }
    return tools;
  };

  /**
   * A new link. A snapshot link is for the owner or an admin. A live link is
   * for the owner alone, because its calls use the owner's connections, and
   * it records who granted it and a subset of the version's approved tools.
   */
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
    const live = parsed.dataMode === "live";
    if (live && !canCreateLiveLink(artifact, policyUser(user))) {
      throw new ForbiddenError(CREATE_SHARE_ACTION);
    }
    if (linksOff || !(await getLinkSwitch(db, user.workspaceId))) {
      throw new ServiceError(
        "invalid",
        "Link sharing is turned off for this workspace."
      );
    }
    const now = clock.now();
    const { expiresAt, versionId } = await checkedShareOptions(
      artifact,
      parsed,
      now
    );
    const liveTools = live
      ? await checkedLiveTools(artifact, versionId, parsed.liveTools ?? [])
      : null;
    const id = ulid(now.getTime());
    const { hash, token } = await hashedToken(ARTIFACT_SHARE_TOKEN_PREFIX);
    const row: ArtifactShareRow = {
      artifactId: artifact.id,
      createdAt: now.toISOString(),
      createdBy: user.userId,
      dataMode: live ? "live" : "snapshot",
      expiresAt,
      grantedBy: live ? user.userId : null,
      id,
      kind: "link",
      lastOpenedAt: null,
      liveTools: liveTools ? JSON.stringify(liveTools) : null,
      openCount: 0,
      revokedAt: null,
      revokedBy: null,
      tokenEncrypted: await encryptSecret(
        await cryptoKey(),
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
        payload: {
          artifactId: artifact.id,
          dataMode: row.dataMode,
          expiresAt,
          ...(liveTools ? { liveTools } : {}),
          shareId: id,
          versionId,
        },
        type: "artifact.share_created",
        workspaceId: user.workspaceId,
      }),
    ]);
    return await toShare(row, now, true);
  };

  /** Revokes a link. A link that is already revoked keeps its first revocation. */
  const revokeShare = async (
    principal: Principal,
    input: ArtifactsRevokeShareInput
  ): Promise<void> => {
    const user = requireSessionUser(principal, REVOKE_SHARE_ACTION);
    const { shareId } = artifactsRevokeShareInputSchema.parse(input);
    const share = await getShareById(db, user.workspaceId, shareId);
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
    const user = requireSessionUser(principal, VIEWS_ACTION);
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

  /** Whether the workspace switch for link sharing is on. Any member may read it. */
  const linksEnabled = async (principal: Principal): Promise<boolean> => {
    const user = requireUser(principal, LINKS_ENABLED_ACTION);
    authorize(user, LINKS_ENABLED_ACTION, {
      kind: "workspace",
      workspaceId: user.workspaceId,
    });
    return await getLinkSwitch(db, user.workspaceId);
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
   * What the access log keeps of a visitor: a salted daily hash of the IP and
   * user agent, the IP prefix and the cut user agent. Never the address.
   */
  const visitorMeta = async (
    workspaceId: string,
    request: Pick<ShareRequestInfo, "cf" | "ip" | "userAgent">,
    now: Date = clock.now()
  ): Promise<VisitorMeta> => {
    let hash: string | null = null;
    if (request.ip) {
      const salt = await ensureViewSalt(
        db,
        workspaceId,
        utcDay(now),
        newSalt()
      );
      hash = await visitorHash(salt, request.ip, request.userAgent ?? "");
    }
    return {
      ipPrefix: request.ip ? truncateIp(request.ip) : null,
      place: request.cf?.country || null,
      userAgent: cutUserAgent(request.userAgent),
      visitorHash: hash,
    };
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
    const meta = await visitorMeta(share.workspaceId, request, now);
    const cf = request.cf ?? {};
    const text = (value: string | null | undefined) => value || null;
    return {
      artifactId: share.artifactId,
      asn: cf.asn === null || cf.asn === undefined ? null : String(cf.asn),
      asOrg: text(cf.asOrganization),
      city: text(cf.city),
      country: meta.place,
      createdAt: now.toISOString(),
      id: ulid(now.getTime()),
      ipPrefix: meta.ipPrefix,
      outcome,
      referrerHost: referrerHost(request.referrer),
      region: text(cf.region),
      shareId: share.shareId,
      surface: "share",
      userAgent: meta.userAgent,
      versionId,
      visitorHash: meta.visitorHash,
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
    // Without a signing key no link can open: refuse like any dead link, before a view row is written.
    if (!(viewKey && token.startsWith(ARTIFACT_SHARE_TOKEN_PREFIX))) {
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
        workspaceId: share.workspaceId,
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

  /** The granter must still own the artifact and sit in its workspace's org (R2.11). No cache. */
  const granterStillValid = async (share: {
    clerkOrgId: string;
    grantedBy: string | null;
    ownerUserId: string | null;
  }): Promise<boolean> =>
    share.grantedBy !== null &&
    share.ownerUserId === share.grantedBy &&
    isOrgMember !== undefined &&
    (await isOrgMember(share.grantedBy, share.clerkOrgId));

  /** Whether a live link may run `tool` right now: a live link, the tool in its list and in the version's grants, and a granter who still qualifies. */
  const liveCallAllowed = async (
    share: Parameters<typeof granterStillValid>[0] & {
      dataMode: "live" | "snapshot";
      liveTools: string | null;
      workspaceId: string;
    },
    versionId: string,
    tool: string
  ): Promise<boolean> =>
    share.dataMode === "live" &&
    runner !== undefined &&
    parseLiveTools(share.liveTools)?.includes(tool) === true &&
    (await approvedTools(share.workspaceId, versionId)).includes(tool) &&
    (await granterStillValid(share));

  /**
   * A link viewer calls a tool (PRD section 4, R2.6, R2.10 to R2.14). The
   * token is looked up by its hash and every check runs now, with no cache:
   * the link is alive, it is a live link, the tool is in `live_tools` and in
   * the shown version's approved grants, the granter still owns the artifact
   * and belongs to an allowed org, and the rate limits hold. The tool then
   * runs as the granter through B.5's runner, which scrubs and caps the result.
   * Every known link writes one `live_call` row with the tool key and the
   * outcome. An unknown token writes nothing and reads as not found.
   */
  const callLink = async (
    token: string,
    input: ShareCallInput,
    request: ShareRequestInfo
  ): Promise<LinkCallResult> => {
    const call = shareCallInputSchema.parse(input);
    if (!token.startsWith(ARTIFACT_SHARE_TOKEN_PREFIX)) {
      return { ok: false, reason: "not_found" };
    }
    const share = await getShareByHash(db, await hashToken(token));
    if (!share) {
      return { ok: false, reason: "not_found" };
    }
    const now = clock.now();
    return await callKnownShare(
      share,
      call,
      now,
      await viewRow(share, null, "ok", request, now)
    );
  };

  /**
   * A live call refused before the service ran it (the route's flood guard, or
   * a body that is not a call) still writes its `live_call` row (R2.14), when
   * the link is known. A dead link keeps its own outcome (`revoked`,
   * `expired`, `disabled`). An unknown token writes nothing; the route answers
   * the same either way.
   */
  const recordRefusedCall = async (
    token: string,
    reason: "rate_limited" | "refused",
    request: ShareRequestInfo
  ): Promise<void> => {
    if (!token.startsWith(ARTIFACT_SHARE_TOKEN_PREFIX)) {
      return;
    }
    const share = await getShareByHash(db, await hashToken(token));
    if (!share) {
      return;
    }
    const now = clock.now();
    const version = await linkVersion(share);
    const dead = linkOutcome(share, version !== undefined, now, linksOff);
    const row = await viewRow(
      share,
      version ? version.id : null,
      dead === "ok" ? reason : dead,
      request,
      now
    );
    await atomic([
      insertViewStatement(db, { ...row, surface: "live_call", toolKey: null }),
    ]);
  };

  /**
   * A link viewer calls a tool through the app gateway, which holds the share
   * id and the visitor's request metadata but not the token. The same checks
   * as `callLink` run; the row's visitor fields come from `meta`. An unknown
   * share id, or one of another artifact, writes nothing.
   */
  const callShare = async (
    shareId: string,
    artifactId: string,
    input: ShareCallInput,
    meta: VisitorMeta
  ): Promise<LinkCallResult> => {
    const call = shareCallInputSchema.parse(input);
    const share = await getShareLookupById(db, shareId, artifactId);
    if (!share) {
      return { ok: false, reason: "not_found" };
    }
    const now = clock.now();
    return await callKnownShare(share, call, now, {
      artifactId: share.artifactId,
      asn: null,
      asOrg: null,
      city: null,
      country: meta.place,
      createdAt: now.toISOString(),
      id: ulid(now.getTime()),
      ipPrefix: meta.ipPrefix,
      outcome: "ok",
      referrerHost: null,
      region: null,
      shareId: share.shareId,
      surface: "share",
      userAgent: meta.userAgent,
      versionId: null,
      visitorHash: meta.visitorHash,
      workspaceId: share.workspaceId,
    });
  };

  /** The state of a link by id, with no cache: alive (and its data mode) or why not. */
  const shareState = async (
    shareId: string,
    artifactId: string
  ): Promise<ShareState> => {
    const share = await getShareLookupById(db, shareId, artifactId);
    if (!share) {
      return { ok: false, reason: "unknown" };
    }
    const version = await linkVersion(share);
    const outcome = linkOutcome(
      share,
      version !== undefined,
      clock.now(),
      linksOff
    );
    if (outcome === "ok") {
      return { dataMode: share.dataMode, ok: true };
    }
    // `linkOutcome` only refuses with these three.
    return {
      ok: false,
      reason:
        outcome === "expired" || outcome === "disabled" ? outcome : "revoked",
    };
  };

  /**
   * The checks and the run for a link that is known, whichever way it was
   * found. `row` holds the visitor fields; the version and the outcome are
   * set here.
   */
  const callKnownShare = async (
    share: Parameters<typeof runGranted>[0] &
      Parameters<typeof linkOutcome>[0] & {
        artifactId: string;
        currentVersionId: string | null;
        shareId: string;
        versionId: string | null;
      },
    call: ShareCallInput,
    now: Date,
    row: NewArtifactView
  ): Promise<LinkCallResult> => {
    const version = await linkVersion(share);
    const base = {
      ...row,
      surface: "live_call" as const,
      toolKey: call.tool,
      versionId: version ? version.id : null,
    };
    const dead = linkOutcome(share, version !== undefined, now, linksOff);
    if (dead !== "ok" || !version) {
      await atomic([
        insertViewStatement(db, {
          ...base,
          outcome: dead === "ok" ? "revoked" : dead,
        }),
      ]);
      return { ok: false, reason: "not_found" };
    }
    // The row goes in first, as the reservation of this call. The limits count
    // it, so calls in flight at the same moment cannot all pass an old count.
    // Its outcome is set once the call is decided.
    await atomic([insertViewStatement(db, base)]);
    if (await overLimit(share.shareId, base.visitorHash ?? null, now)) {
      await atomic([setViewOutcomeStatement(db, base.id, "rate_limited")]);
      return { ok: false, reason: "rate_limited" };
    }
    return await runGranted(share, version.id, call, base.id);
  };

  /**
   * The checks that need the granter and the version's grants, then the run.
   * The row of the call already exists with outcome `ok`; a refusal or a
   * failure sets its outcome.
   */
  const runGranted = async (
    share: Parameters<typeof liveCallAllowed>[0] & {
      agentId: string | null;
      grantedBy: string | null;
    },
    versionId: string,
    call: ShareCallInput,
    viewId: string
  ): Promise<LinkCallResult> => {
    try {
      const allowed =
        (await liveCallAllowed(share, versionId, call.tool)) &&
        (await checkToolLimits(db, {
          args: call.arguments ?? {},
          tool: call.tool,
          versionId,
          workspaceId: share.workspaceId,
        })) === null;
      if (allowed && runner && share.grantedBy) {
        return await runRecorded(runner, share.grantedBy, share, call, viewId);
      }
      await atomic([setViewOutcomeStatement(db, viewId, "refused")]);
      return { ok: false, reason: "forbidden" };
    } catch (error) {
      // A failed check (the membership lookup, the database) fails closed.
      console.error("Live link check failed", errorLabel(error));
      await atomic([setViewOutcomeStatement(db, viewId, "error")]);
      return { ok: false, reason: "failed" };
    }
  };

  const runRecorded = async (
    toolRunner: ToolRunner,
    userId: string,
    share: { agentId: string | null; workspaceId: string },
    call: ShareCallInput,
    viewId: string
  ): Promise<LinkCallResult> => {
    try {
      const { result } = await toolRunner.run({
        agentId: share.agentId,
        arguments: call.arguments ?? {},
        toolKey: call.tool,
        userId,
        workspaceId: share.workspaceId,
      });
      return { ok: true, result };
    } catch (error) {
      const refused =
        isArtifactCallError(error) && error.code === "not_granted";
      await atomic([
        setViewOutcomeStatement(db, viewId, refused ? "refused" : "error"),
      ]);
      if (!refused) {
        console.error("Live link call failed", errorLabel(error));
      }
      return { ok: false, reason: refused ? "forbidden" : "failed" };
    }
  };

  /** Whether the link or the visitor is over a live call limit right now (R2.13). The counts include the call asking. */
  const overLimit = async (
    shareId: string,
    visitorKey: string | null,
    now: Date
  ): Promise<boolean> => {
    const since = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const [minute, day, byVisitor] = await Promise.all([
      countLiveCalls(db, { shareId, since: since(MINUTE_MS) }),
      countLiveCalls(db, { shareId, since: since(DAY_MS) }),
      countLiveCalls(db, {
        shareId,
        since: since(MINUTE_MS),
        visitorHash: visitorKey,
      }),
    ]);
    return (
      minute > LIVE_CALLS_PER_LINK_MINUTE ||
      day > LIVE_CALLS_PER_LINK_DAY ||
      byVisitor > LIVE_CALLS_PER_VISITOR_MINUTE
    );
  };

  /**
   * A link viewer reads the app's shared storage (`get` or `list`). The link
   * is checked as for an open, so a revoked, expired or disabled one is not
   * found. Writes are always forbidden: a link holder never changes shared
   * data. No access-log row is written, because reads are not tool calls.
   */
  const storageLink = async (
    token: string,
    input: ShareStorageInput
  ): Promise<LinkStorageResult> => {
    const parsed = shareStorageInputSchema.parse(input);
    if (!token.startsWith(ARTIFACT_SHARE_TOKEN_PREFIX)) {
      return { ok: false, reason: "not_found" };
    }
    const share = await getShareByHash(db, await hashToken(token));
    if (!share) {
      return { ok: false, reason: "not_found" };
    }
    const version = await linkVersion(share);
    if (
      linkOutcome(share, version !== undefined, clock.now(), linksOff) !== "ok"
    ) {
      return { ok: false, reason: "not_found" };
    }
    if (parsed.op === "set" || parsed.op === "delete") {
      return { ok: false, reason: "forbidden" };
    }
    if (!store) {
      return { ok: false, reason: "failed" };
    }
    const scope = {
      area: "shared" as const,
      artifactId: share.artifactId,
      viewerKey: `l:${share.shareId}`,
    };
    try {
      if (parsed.op === "list") {
        const items = await store.list(scope, parsed.prefix ?? "", LIST_LIMIT);
        return { ok: true, result: { keys: items.map((item) => item.key) } };
      }
      const text = await store.get(scope, parsed.key ?? "");
      return { ok: true, result: { value: storedValue(text) } };
    } catch (error) {
      console.error("Link storage read failed", error);
      return { ok: false, reason: "failed" };
    }
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
    callLink,
    callShare,
    createShare,
    linksEnabled,
    mintTestToken,
    open,
    openLink,
    prune,
    recordRefusedCall,
    revokeShare,
    setLinksEnabled,
    shareState,
    shares,
    storageLink,
    views,
    visitorMeta,
  };
};

export type ArtifactSharesService = ReturnType<
  typeof createArtifactSharesService
>;
