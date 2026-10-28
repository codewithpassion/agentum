import { createClerkClient } from "@clerk/backend";
import {
  type Block,
  DocumentError,
  LiveDocument,
  type Operation,
} from "@repo/live-doc";
import { toMarkdown } from "@repo/live-doc/schema";
import type {
  DocumentOperation,
  DocumentReadInput,
  DocumentReadResult,
} from "@repo/mcp/tools/live";
import type { LiveOperationOrigin } from "@repo/protocol/live";
import { commentAnchorSchema } from "@repo/protocol/live";
import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import type {
  DocumentSnapshot,
  GuestPublicationActor,
} from "@repo/services/live-artifacts/service";
import { verifyRoomTicket } from "@repo/services/live-artifacts/ticket";
import { createGuestArtifacts } from "@repo/services/live-guests/artifacts";
import { GUEST_COOKIE } from "@repo/services/live-guests/security";
import type { SpeakerRoom } from "@repo/services/speaker-envelope";
import { type Principal, SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { applyUpdate, Doc, XmlElement } from "yjs";
import { type Composed, compose } from "../compose";
import { resolveDocumentAnchor } from "./anchors";
import { ArtifactRoom as Room } from "./artifact-room";
import { type AgentRange, insertedRanges } from "./attribution";
import { authenticateRoomRequest, freshMember } from "./auth";
import { editMarkdownImageUrls, withStoredImages } from "./edit-image-ops";
import { roomName } from "./namespace";
import { findBlock, translateOperation } from "./operations";
import type { ArtifactRoomService, RoomScope } from "./ports";
import { requiredLive } from "./required";
import { RoomStorage } from "./storage";

interface Credential {
  expiresAt: number;
  guest?: { sessionId: string; artifactId: string; workspaceId: string };
  principal?: Principal;
  request?: { url: string; headers: [string, string][] };
  session?: { id: string; userId: string; workspaceId: string };
}
const resolveSession = async (
  env: Env,
  composed: Composed,
  sessionRef: NonNullable<Credential["session"]>
) => {
  const session = await createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
  }).sessions.getSession(sessionRef.id);
  if (
    session.userId !== sessionRef.userId ||
    session.status !== "active" ||
    session.expireAt <= Date.now()
  ) {
    return null;
  }
  return freshMember(env, composed, sessionRef.workspaceId, sessionRef.userId);
};
const resolveCredential = async (
  env: Env,
  composed: Composed,
  credential: Credential | undefined
): Promise<Principal | null> => {
  if (!credential || credential.expiresAt <= Date.now()) {
    return null;
  }
  if (credential.session) {
    return resolveSession(env, composed, credential.session);
  }
  if (credential.request) {
    return authenticateRoomRequest(
      env,
      composed,
      new Request(credential.request.url, {
        headers: credential.request.headers,
      })
    );
  }
  const { principal } = credential;
  if (!principal) {
    return null;
  }
  const refreshed = await requiredLive(
    composed.services
  ).refreshTrustedPrincipal(principal);
  if (refreshed.kind === "user") {
    const member = await freshMember(
      env,
      composed,
      refreshed.workspaceId,
      refreshed.userId
    );
    return member
      ? { ...refreshed, isAdmin: refreshed.apiKey ? false : member.isAdmin }
      : null;
  }
  return refreshed;
};
const storeCredential = async (
  ctx: DurableObjectState,
  env: Env,
  principal: Principal,
  request: Request
) => {
  const authorizationRef = crypto.randomUUID();
  const headers: [string, string][] = [];
  for (const name of ["authorization", "cookie"]) {
    const value = request.headers.get(name);
    if (value) {
      headers.push([name, value]);
    }
  }
  const url = new URL(request.url);
  url.search = "";
  await ctx.storage.put(`credential:${authorizationRef}`, {
    expiresAt: Date.now() + 15 * 60_000,
    request: { headers, url: url.toString() },
  } satisfies Credential);
  if (!request.headers.has("Authorization") && principal.kind === "user") {
    const auth = (
      await createClerkClient({
        secretKey: env.CLERK_SECRET_KEY,
      }).authenticateRequest(request)
    ).toAuth();
    if (!auth?.sessionId || auth.userId !== principal.userId) {
      throw new Error("Invalid authenticated session");
    }
    await ctx.storage.put(`credential:${authorizationRef}`, {
      expiresAt: Date.now() + 15 * 60_000,
      session: {
        id: auth.sessionId,
        userId: principal.userId,
        workspaceId: principal.workspaceId,
      },
    } satisfies Credential);
  }
  await ctx.storage.put(`acceptedActor:${authorizationRef}`, principal);
  await ctx.storage.put(`actor:${participant(principal)}`, authorizationRef);
  return authorizationRef;
};
const participant = (principal: Principal) => {
  if (principal.kind === "user") {
    return `u:${principal.userId}`;
  }
  if (principal.kind === "run") {
    return `a:${principal.agentId}:${principal.runId}`;
  }
  return "";
};
const trialOperation = (live: LiveDocument, engineOp: Operation): Operation => {
  const trialOp = structuredClone(engineOp);
  if ("ifRev" in trialOp) {
    let id: string | undefined;
    if ("blockId" in trialOp) {
      id = trialOp.blockId;
    } else if ("target" in trialOp && "blockId" in trialOp.target) {
      id = trialOp.target.blockId;
    }
    if (id) {
      trialOp.ifRev = live.read().blocks.find((b) => b.id === id)?.revision;
    }
  }

  return trialOp;
};
const translateBatch = (
  live: LiveDocument,
  revisions: Record<string, number>,
  ops: DocumentOperation[],
  origin: LiveOperationOrigin
) => {
  const translated: Operation[] = [];
  for (const op of ops) {
    const target = op.target && "blockId" in op.target ? op.target : undefined;
    if (
      target &&
      "ifRev" in target &&
      target.ifRev !== revisions[target.blockId]
    ) {
      throw new DocumentError(
        "guard_mismatch",
        live.read().blocks.find((b) => b.id === target.blockId)
      );
    }
    const engineOp = translateOperation(live, op);
    translated.push(engineOp);
    const trialOp = trialOperation(live, engineOp);
    live.apply([trialOp], { ...origin, mode: "direct" });
  }

  return translated;
};
const HTTP_SOURCE = /^https?:\/\//i;
type StagedImages =
  | { ok: true; ids: string[]; ops: Operation[] }
  | { ok: false; code: "forbidden" | "validation"; message: string };
const ticketKey = (env: Env) =>
  env.ARTIFACT_VIEW_KEY ? `artifact-room:${env.ARTIFACT_VIEW_KEY}` : "";

export { ticketKey as roomTicketKey };

/** Production wrapper supplies required in-process ports. There is deliberately
 * no ARTIFACT_ROOM_SERVICE Worker binding. Credential material stays in private
 * room storage; sockets persist only opaque references. */
export class ArtifactRoom extends Room {
  private readonly productionEnv: Env;
  private readonly state: DurableObjectState;
  private readonly composed: () => Composed;
  constructor(ctx: DurableObjectState, env: Env) {
    let composed: Composed | undefined;
    const get = () => {
      composed ??= compose(env, false);
      return composed;
    };
    const live = () => requiredLive(get().services);
    const resolve = async (ref: string): Promise<Principal | null> => {
      const credential = await ctx.storage.get<Credential>(`credential:${ref}`);
      return resolveCredential(env, get(), credential);
    };
    const guestAccess = () =>
      createGuestArtifacts({
        ...get(),
        guestsOff: () =>
          Boolean((env as Env & { LIVE_GUESTS_OFF?: string }).LIVE_GUESTS_OFF),
      });
    const guestIdentity = async (ref: string, scope: RoomScope) => {
      const credential = await ctx.storage.get<Credential>(`credential:${ref}`);
      if (
        !credential?.guest ||
        credential.expiresAt <= Date.now() ||
        credential.guest.artifactId !== scope.artifactId ||
        credential.guest.workspaceId !== scope.workspaceId
      ) {
        return null;
      }
      const grant = await guestAccess().resolveReference(credential.guest);
      return grant
        ? {
            authorizationRef: ref,
            color: "#059669",
            kind: "guest" as const,
            name: grant.displayName.slice(0, 200) || "Guest",
            participantId: `g:${grant.guestId}`,
            role: grant.role,
          }
        : null;
    };
    const authorizeGuest = async (
      ref: string,
      scope: RoomScope,
      subject: Parameters<ArtifactRoomService["authorize"]>[1]
    ) => {
      const identity = await guestIdentity(ref, scope);
      if (identity?.participantId !== subject.participantId) {
        return null;
      }
      if (identity.role === "editor") {
        const credential = await ctx.storage.get<Credential>(
          `credential:${ref}`
        );
        const grant = credential?.guest
          ? await guestAccess().resolveReference(credential.guest)
          : null;
        if (!grant) {
          return null;
        }
        await ctx.storage.put(`acceptedActor:${ref}`, {
          artifactId: grant.artifactId,
          guestId: grant.guestId,
          kind: "guest",
          workspaceId: grant.workspaceId,
        } satisfies GuestPublicationActor);
        await ctx.storage.put("checkpointActor", ref);
      }
      return identity;
    };
    const authorize: ArtifactRoomService["authorize"] = async (
      scope,
      subject
    ) => {
      const ref =
        subject.authorizationRef ??
        (await ctx.storage.get<string>(`actor:${subject.participantId}`));
      if (!ref) {
        return null;
      }
      try {
        if ((await ctx.storage.list({ prefix: "accessFence:" })).size) {
          return null;
        }
        if (subject.kind === "guest") {
          return authorizeGuest(ref, scope, subject);
        }
        const principal = await resolve(ref);
        if (
          !principal ||
          participant(principal) !== subject.participantId ||
          principal.kind === "system" ||
          principal.workspaceId !== scope.workspaceId
        ) {
          return null;
        }
        const identity = await live().roomIdentity(principal, scope.artifactId);
        await ctx.storage.put(
          `actorRole:${identity.participantId}`,
          identity.role
        );
        if (identity.kind !== subject.kind) {
          return null;
        }
        if (identity.role === "owner" || identity.role === "editor") {
          await ctx.storage.put(`acceptedActor:${ref}`, principal);
          await ctx.storage.put("checkpointActor", ref);
        }
        return { ...identity, authorizationRef: ref };
      } catch {
        return null;
      }
    };
    const admitGuest: ArtifactRoomService["admit"] = async (
      scope,
      ticket,
      context
    ) => {
      let ref: string;
      if ("request" in context) {
        const cookies =
          context.request.headers
            .get("Cookie")
            ?.split(";")
            .map((v) => v.trim()) ?? [];
        const matches = cookies.filter((v) => v.startsWith(`${GUEST_COOKIE}=`));
        if (matches.length !== 1) {
          return null;
        }
        const sessionToken = matches[0]?.slice(GUEST_COOKIE.length + 1) ?? "";
        const row = await guestAccess().sessionReference({
          ...scope,
          sessionToken,
        });
        if (!row) {
          return null;
        }
        ref = crypto.randomUUID();
        await ctx.storage.put(`credential:${ref}`, {
          expiresAt: Date.now() + 900_000,
          guest: { ...scope, sessionId: row.sessionId },
        } satisfies Credential);
      } else {
        ref = context.authorizationRef;
      }
      const identity = await guestIdentity(ref, scope);
      const claims = await verifyRoomTicket(ticket, ticketKey(env), {
        ...scope,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      if (
        !(identity && claims) ||
        claims.kind !== "guest" ||
        claims.participantId !== identity.participantId ||
        claims.role !== identity.role
      ) {
        return null;
      }
      const credential = await ctx.storage.get<Credential>(`credential:${ref}`);
      if (!credential) {
        return null;
      }
      await ctx.storage.put(`credential:${ref}`, {
        ...credential,
        expiresAt: Date.now() + 900_000,
      });
      await ctx.storage.put(`actor:${identity.participantId}`, ref);
      return authorize(scope, identity);
    };
    const service: ArtifactRoomService = {
      admit: async (scope, ticket, context) => {
        if (
          ("request" in context &&
            new URL(context.request.url).pathname.startsWith("/api/guest/")) ||
          ("authorizationRef" in context &&
            (
              await ctx.storage.get<Credential>(
                `credential:${context.authorizationRef}`
              )
            )?.guest)
        ) {
          return admitGuest(scope, ticket, context);
        }
        let authorizationRef: string;
        let principal: Principal | null;
        if ("request" in context) {
          principal = await authenticateRoomRequest(
            env,
            get(),
            context.request
          );
          if (!principal || participant(principal) === "") {
            return null;
          }
          await live().admit(principal, {
            artifactId: scope.artifactId,
            ticket,
          });
          authorizationRef = await storeCredential(
            ctx,
            env,
            principal,
            context.request
          );
        } else {
          ({ authorizationRef } = context);
          principal = await resolve(authorizationRef);
          if (!principal) {
            return null;
          }
          await live().admit(principal, {
            artifactId: scope.artifactId,
            ticket,
          });
        }
        const credential = await ctx.storage.get<Credential>(
          `credential:${authorizationRef}`
        );
        if (!credential) {
          return null;
        }
        await ctx.storage.put(`credential:${authorizationRef}`, {
          ...credential,
          expiresAt: Date.now() + 15 * 60_000,
        });
        return authorize(scope, {
          authorizationRef,
          kind: principal.kind === "user" ? "member" : "agent",
          participantId: participant(principal),
        });
      },
      authorize,
      open: async (objectId) => {
        const scope = await ctx.storage.get<RoomScope>("productionScope");
        if (
          !scope ||
          env.ARTIFACT_ROOM.idFromName(roomName(scope)).toString() !== objectId
        ) {
          throw new Error("Room scope not bound");
        }
        return live().roomOpen(SYSTEM_PRINCIPAL, scope);
      },
      ownBlobUrls: async (scope) => {
        if ((await ctx.storage.list({ prefix: "accessFence:" })).size) {
          throw new Error("Access mutation in progress");
        }
        return (await live().roomPolicy(SYSTEM_PRINCIPAL, scope)).ownBlobUrls;
      },
      prepareCheckpoint: async (scope, restores, acceptedIdentity) => {
        const ref =
          acceptedIdentity?.authorizationRef ??
          (restores.at(-1)
            ? await ctx.storage.get<string>(
                `actor:${restores.at(-1)?.byParticipant}`
              )
            : await ctx.storage.get<string>("checkpointActor"));
        const actor = ref
          ? await ctx.storage.get<Principal | GuestPublicationActor>(
              `acceptedActor:${ref}`
            )
          : undefined;
        if (
          !actor ||
          actor.kind === "system" ||
          actor.workspaceId !== scope.workspaceId
        ) {
          throw new Error("Missing accepted checkpoint provenance");
        }
        return JSON.stringify(actor);
      },
      protectedRanges: async (scope) =>
        (await live().roomPolicy(SYSTEM_PRINCIPAL, scope)).ranges,
      save: async (scope, input) => {
        if (!input.publicationReceipt) {
          throw new Error("Missing frozen checkpoint provenance");
        }
        const actor: Principal | GuestPublicationActor = JSON.parse(
          input.publicationReceipt
        );
        if (
          actor.kind === "system" ||
          actor.workspaceId !== scope.workspaceId
        ) {
          throw new Error("Wrong checkpoint publication scope");
        }
        const store = new RoomStorage(ctx.storage);
        const origins = input.origins
          .map((origin) => {
            const record = store.get<{ revision: number }>(
              `change:${origin.changeId}`
            );
            const metadata = store.get<{ summary: string; revFrom: number }>(
              `productionChange:${origin.changeId}`
            );
            if (!(record && metadata)) {
              throw new Error("Missing durable change provenance");
            }
            return { ...origin, ...metadata, revTo: record.revision };
          })
          .filter((origin) => origin.revTo > origin.revFrom);
        const result = await live().durableCheckpoint(
          SYSTEM_PRINCIPAL,
          {
            ...scope,
            ...input,
            origins,
          },
          actor
        );
        return result;
      },
    };
    super(ctx, {
      ARTIFACT_ROOM_SERVICE: service,
      ARTIFACT_ROOM_TICKET_KEY: ticketKey(env),
    });
    this.productionEnv = env;
    this.state = ctx;
    this.composed = get;
  }
  async suspend(mutationId: string) {
    await this.state.storage.put(`accessFence:${mutationId}`, Date.now());
    // refresh is serialized behind in-flight room mutations. Only after this
    // acknowledgement may the caller commit the access change in D1.
    await super.refresh();
  }
  async completeInvalidation(participantId?: string, mutationId?: string) {
    if (mutationId) {
      await this.state.storage.delete(`accessFence:${mutationId}`);
    }
    await super.refresh(participantId);
  }
  async restoreAuthorized(input: {
    snapshot: DocumentSnapshot;
    versionId: string;
    byParticipant: string;
    requestId?: string;
  }) {
    let requestId =
      input.requestId ??
      (await this.state.storage.get<string>("currentRestore"));
    if (!requestId) {
      requestId = crypto.randomUUID();
      await this.state.storage.put("currentRestore", requestId);
    }
    return super.restore({ ...input, requestId });
  }
  override async checkpoint() {
    const result = await super.checkpoint();
    await this.state.storage.delete("currentRestore");
    return result;
  }
  private async snapshotController() {
    await super.read();
    const scope = await this.state.storage.get<RoomScope>("productionScope");
    if (!scope) {
      throw new Error("Unbound scope");
    }
    const policy = await requiredLive(this.composed().services).roomPolicy(
      SYSTEM_PRINCIPAL,
      scope
    );
    const store = new RoomStorage(this.state.storage);
    const meta = store.get<{
      generation: number;
      sequence: number;
      baseSequence: number;
      revision: number;
      ownBlobUrls: string[];
      blockRevisions: Record<string, number>;
    }>("state");
    if (!meta) {
      throw new Error("Missing room state");
    }
    const doc = new Doc({ gc: false });
    applyUpdate(doc, store.read("snapshot", String(meta.generation)));
    for (let i = meta.baseSequence + 1; i <= meta.sequence; i += 1) {
      applyUpdate(doc, store.read("update", String(i)));
    }
    return {
      live: new LiveDocument(doc, {
        ownBlobUrls: new Set(policy.ownBlobUrls),
        revision: meta.revision,
      }),
      meta,
    };
  }
  async documentRead(
    input: Omit<DocumentReadInput, "artifactId">
  ): Promise<Omit<DocumentReadResult, "artifactId">> {
    const result = await super.read();
    if (typeof result.content === "string") {
      throw new Error("Outline required");
    }
    const store = new RoomStorage(this.state.storage);
    const history =
      store.get<Array<{ revision: number; bytes: number }>>(
        "productionHistoryIndex"
      ) ?? [];
    if (!history.some((entry) => entry.revision === result.revision)) {
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          blocks: result.content.blocks,
          revision: result.revision,
        })
      );
      if (bytes.length <= 32 * 1024 * 1024) {
        this.state.storage.transactionSync(() => {
          store.write("outline", String(result.revision), bytes);
          history.push({ bytes: bytes.length, revision: result.revision });
          while (
            history.length > 100 ||
            history.reduce((total, entry) => total + entry.bytes, 0) >
              32 * 1024 * 1024
          ) {
            const removed = history.shift();
            if (removed) {
              store.remove("outline", String(removed.revision));
            }
          }
          store.put("productionHistoryIndex", history);
        });
      }
    }
    const historical = (revision: number) =>
      history.some((entry) => entry.revision === revision)
        ? (JSON.parse(
            new TextDecoder().decode(store.read("outline", String(revision)))
          ) as { revision: number; blocks: Block[] })
        : undefined;
    const chosen =
      input.atRev === undefined || input.atRev === result.revision
        ? result.content
        : historical(input.atRev);
    if (!chosen) {
      throw new DocumentError("revision_gone");
    }
    const older =
      input.sinceRev === undefined ? undefined : historical(input.sinceRev);
    if (
      input.sinceRev !== undefined &&
      !older &&
      input.sinceRev !== result.revision
    ) {
      throw new DocumentError("revision_gone");
    }
    const deletedBlockIds: string[] = [];
    if (older) {
      for (const block of older.blocks) {
        if (!chosen.blocks.some((current) => current.id === block.id)) {
          deletedBlockIds.push(block.id);
        }
      }
    }
    return {
      blocks: chosen.blocks
        .filter(
          (b) =>
            (!input.blockId || b.id === input.blockId) &&
            (input.sinceRev === undefined || b.revision > input.sinceRev)
        )
        .map((b) => ({
          hash: b.hash,
          id: b.id,
          intent:
            b.type === "pending"
              ? String(b.content.attrs?.intent ?? "")
              : undefined,
          markdown: toMarkdown({ content: [b.content], type: "doc" }),
          rev: b.revision,
          text: b.text,
          type: b.type,
        })),
      deletedBlockIds,
      present: result.present,
      revision: chosen.revision,
    };
  }
  /** Resolve the cookie against this room before reading trusted presence. */
  async guestAskPresence(sessionToken: string) {
    const scope = await this.state.storage.get<RoomScope>("productionScope");
    if (!scope) {
      throw new Error("Wrong scope");
    }
    const composed = this.composed();
    const guests = createGuestArtifacts({
      ...composed,
      guestsOff: () =>
        Boolean(
          (this.productionEnv as Env & { LIVE_GUESTS_OFF?: string })
            .LIVE_GUESTS_OFF
        ),
    });
    const credential = { ...scope, sessionToken };
    const grant = await guests.current(credential, true);
    const result = await this.askPresence(`g:${grant.guestId}`);
    await guests.current(credential, true);
    return result;
  }

  async askPresence(
    participantId: string
  ): Promise<Pick<SpeakerRoom, "present" | "where">> {
    await super.refresh();
    const present = await super.presence();
    const sessions = this.state
      .getWebSockets()
      .map(
        (socket) =>
          socket.deserializeAttachment() as {
            participantId: string;
            role: string;
            expires: number;
            present: import("@repo/protocol/live").AwarenessEntry | null;
            receivedAt?: number;
          }
      )
      .filter((session) => session.expires > Date.now())
      .sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0));
    const sender = sessions.find(
      (session) => session.participantId === participantId
    );
    const isDeck = (await super.roomKind()) === "deck";
    if (isDeck) {
      return {
        present: await Promise.all(
          present
            .filter((entry) => entry.id !== participantId)
            .map(async (entry) => ({
              id: entry.id,
              kind: entry.kind,
              name: entry.name,
              role:
                sessions.find((s) => s.participantId === entry.id)?.role ??
                "viewer",
              where: await super.deckLocation(entry),
            }))
        ),
        where: await super.deckLocation(sender?.present),
      };
    }
    const { live } = await this.snapshotController();
    try {
      const where = this.selectionLocation(live, sender?.present?.cursor);
      const roster = await Promise.all(
        present
          .filter((entry) => entry.id !== participantId)
          .map(async (entry) => ({
            id:
              entry.kind === "member"
                ? entry.id.slice(2)
                : (entry.id.split(":")[1] ?? entry.id),
            kind: entry.kind,
            name: entry.name,
            role:
              sessions.find((session) => session.participantId === entry.id)
                ?.role ??
              (await this.state.storage.get<string>(`actorRole:${entry.id}`)) ??
              "viewer",
            where: this.selectionLocation(live, entry.cursor),
          }))
      );
      return { present: roster, where };
    } finally {
      live.destroy();
      live.doc.destroy();
    }
  }
  private selectionLocation(
    live: LiveDocument,
    cursor: import("@repo/protocol/live").AwarenessEntry["cursor"]
  ): SpeakerRoom["where"] {
    if (!cursor) {
      return;
    }
    try {
      let { type } = live.resolve(cursor.head);
      let blockId: string | undefined;
      while (type) {
        if (
          type instanceof XmlElement &&
          typeof type.getAttribute("id") === "string"
        ) {
          blockId = type.getAttribute("id");
          break;
        }
        if (!type.parent) {
          break;
        }
        type = type.parent;
      }
      let selected = resolveDocumentAnchor(live, {
        detached: false,
        end: cursor.head,
        kind: "document",
        start: cursor.anchor,
      });
      if (selected.anchor.detached) {
        selected = resolveDocumentAnchor(live, {
          detached: false,
          end: cursor.anchor,
          kind: "document",
          start: cursor.head,
        });
      }
      return { blockId, selection: selected.quote?.slice(0, 8192) };
    } catch {
      return {};
    }
  }
  async agentChanges(): Promise<AgentRange[]> {
    const isDeck = (await super.roomKind()) === "deck";
    if (isDeck) {
      return [];
    }
    const { live } = await this.snapshotController();
    const store = new RoomStorage(this.state.storage);
    try {
      const records = this.state.storage.sql
        .exec<{ key: string; value: string }>(
          "SELECT key,value FROM room_meta WHERE key LIKE 'productionChange:%'"
        )
        .toArray()
        .map((row) => ({
          ...(JSON.parse(row.value) as { name?: string; createdAt?: string }),
          id: row.key.slice("productionChange:".length),
        }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 50);
      return records.flatMap((record) => {
        const change = store.get<{ reverted?: unknown }>(`change:${record.id}`);
        if (!change || change.reverted) {
          return [];
        }
        return insertedRanges(live, store.read("change", record.id), {
          id: record.id,
          name: record.name ?? "Agent",
        });
      });
    } finally {
      live.destroy();
      live.doc.destroy();
    }
  }
  async documentAnchor(input: {
    quote: string;
    nth?: number;
    blockId?: string;
  }) {
    const { live } = await this.snapshotController();
    try {
      const blocks = live
        .read()
        .blocks.filter((b) => !input.blockId || b.id === input.blockId);
      const block = findBlock(blocks, { find: input.quote, nth: input.nth });
      let start = -1;
      for (let i = 0; i < (input.nth ?? 1); i += 1) {
        start = block.text.indexOf(input.quote, start + 1);
      }
      if (start < 0) {
        start = block.text.indexOf(input.quote);
      }
      return commentAnchorSchema.parse(
        live.anchor(block.id, start, start + input.quote.length)
      );
    } finally {
      live.destroy();
      live.doc.destroy();
    }
  }
  async documentEdit(
    ops: DocumentOperation[],
    origin: LiveOperationOrigin,
    summary: string
  ) {
    const store = new RoomStorage(this.state.storage);
    const key = `productionChange:${origin.changeId}`;
    const prior = store.get<{ ops?: string }>(key);
    if (prior?.ops !== undefined && prior.ops !== JSON.stringify(ops)) {
      throw new Error("Tool call ID collision");
    }
    if (store.get(`suggestion:${origin.changeId}`)) {
      const result = await super.applyAgentOps(
        JSON.parse(
          store.get<string>(`suggestionPayload:${origin.changeId}`) ?? "null"
        ),
        origin
      );
      return { ok: true as const, ...result };
    }
    if (store.get(`change:${origin.changeId}`)) {
      const result = await super.applyAgentOps([], origin);
      return { ok: true as const, ...result };
    }
    const { live, meta } = await this.snapshotController();
    let staged: StagedImages | undefined;
    try {
      // Guard admission comes first: a mismatch here fetches and writes nothing.
      const translated = translateBatch(live, meta.blockRevisions, ops, origin);
      store.put(key, {
        ops: JSON.stringify(ops),
        revFrom: meta.revision,
        summary,
      });
      staged = await this.stageEditImages(translated, origin);
      if (!staged.ok) {
        return staged;
      }
      const result = await this.edit(staged.ops, origin, summary);
      await this.documentRead({});
      return { ok: true as const, ...result };
    } catch (error) {
      await this.discardEditImages(staged, origin);
      if (error instanceof DocumentError) {
        return {
          code: error.code,
          current: error.current
            ? {
                hash: error.current.hash,
                id: error.current.id,
                rev: error.current.revision,
                text: error.current.text,
                type: error.current.type,
              }
            : undefined,
          ok: false as const,
        };
      }
      throw error;
    } finally {
      live.destroy();
      live.doc.destroy();
    }
  }
  /** Fetches and stores the edit's external Markdown images after guard
   * admission. Ids come from the change id, so a retry reuses the stored files. */
  private async stageEditImages(
    translated: Operation[],
    origin: LiveOperationOrigin
  ): Promise<StagedImages> {
    // Own /files/ paths, data: and relative sources keep the sanitizer's verdict.
    const urls = editMarkdownImageUrls(translated).filter((url) =>
      HTTP_SOURCE.test(url)
    );
    if (!urls.length) {
      return { ids: [], ok: true, ops: translated };
    }
    const scope = await this.state.storage.get<RoomScope>("productionScope");
    if (!scope) {
      throw new Error("Unbound scope");
    }
    const live = requiredLive(this.composed().services);
    let ids: string[] = [];
    try {
      const principal = await this.actingPrincipal(origin.participantId);
      const stored = await live.roomStageEditImages(principal, {
        artifactId: scope.artifactId,
        changeId: origin.changeId,
        urls,
      });
      ({ ids } = stored);
      await this.serializeImages(() =>
        live.roomPublishEditImages(principal, {
          artifactId: scope.artifactId,
          ids,
        })
      );
      return {
        ids,
        ok: true,
        ops: withStoredImages(
          translated,
          new Map(Object.entries(stored.replacements))
        ),
      };
    } catch (error) {
      await this.discardEditImages({ ids, ok: true, ops: [] }, origin);
      if (isForbiddenError(error)) {
        return {
          code: "forbidden",
          message: "External images are not allowed for this credential.",
          ok: false,
        };
      }
      if (isServiceError(error)) {
        return { code: "validation", message: error.message, ok: false };
      }
      throw error;
    }
  }
  /** Removes staged images of a failed edit, unless an accepted change or a
   * suggestion of this change id already uses them. */
  private async discardEditImages(
    staged: StagedImages | undefined,
    origin: LiveOperationOrigin
  ) {
    const store = new RoomStorage(this.state.storage);
    if (
      !(staged?.ok && staged.ids.length) ||
      store.get(`change:${origin.changeId}`) ||
      store.get(`suggestion:${origin.changeId}`)
    ) {
      return;
    }
    const scope = await this.state.storage.get<RoomScope>("productionScope");
    if (!scope) {
      return;
    }
    await this.serializeImages(() =>
      requiredLive(this.composed().services).roomDiscardEditImages(scope, {
        ids: staged.ids,
        runId: origin.runId,
      })
    );
  }
  private async actingPrincipal(participantId: string) {
    const ref = await this.state.storage.get<string>(`actor:${participantId}`);
    const principal = await resolveCredential(
      this.productionEnv,
      this.composed(),
      ref
        ? await this.state.storage.get<Credential>(`credential:${ref}`)
        : undefined
    );
    if (!principal || participant(principal) !== participantId) {
      throw new Error("Acting principal unavailable");
    }
    return principal;
  }
  private imageTail: Promise<unknown> = Promise.resolve();
  /** One writer at a time for the ownership manifest. */
  private serializeImages<T>(action: () => Promise<T>) {
    const result = this.imageTail.then(action);
    this.imageTail = result.catch(() => undefined);
    return result;
  }
  registerImage(fileId: string) {
    return this.serializeImages(async () => {
      const scope = await this.state.storage.get<RoomScope>("productionScope");
      if (!scope) {
        throw new Error("Unbound scope");
      }
      await requiredLive(this.composed().services).roomRegisterImage(
        SYSTEM_PRINCIPAL,
        scope,
        fileId
      );
    });
  }
  async bindScope(scope: RoomScope) {
    if (
      this.productionEnv.ARTIFACT_ROOM.idFromName(
        roomName(scope)
      ).toString() !== this.state.id.toString()
    ) {
      throw new Error("Wrong namespace scope");
    }
    const prior = await this.state.storage.get<RoomScope>("productionScope");
    if (prior && roomName(prior) !== roomName(scope)) {
      throw new Error("Immutable room scope");
    }
    await this.state.storage.put("productionScope", scope);
  }
  async guestSuggestions(
    sessionToken: string,
    decision?: { suggestionId: string; decision: "accept" | "reject" }
  ) {
    const scope = await this.state.storage.get<RoomScope>("productionScope");
    if (!scope) {
      throw new Error("Unbound scope");
    }
    const access = createGuestArtifacts({
      ...this.composed(),
      guestsOff: () =>
        Boolean(
          (this.productionEnv as Env & { LIVE_GUESTS_OFF?: string })
            .LIVE_GUESTS_OFF
        ),
    });
    const row = await access.sessionReference({ ...scope, sessionToken });
    if (!row || (decision && row.role !== "editor")) {
      throw new Error("Guest access unavailable");
    }
    const ref = crypto.randomUUID();
    await this.state.storage.put(`credential:${ref}`, {
      expiresAt: Date.now() + 900_000,
      guest: { ...scope, sessionId: row.sessionId },
    } satisfies Credential);
    const identity = {
      authorizationRef: ref,
      kind: "guest" as const,
      participantId: `g:${row.guestId}`,
    };
    await this.state.storage.put(`actor:${identity.participantId}`, ref);
    if (decision) {
      const result = await super.decideSuggestion(decision, identity);
      if (result.status === "accepted") {
        await this.checkpoint();
      }
    }
    return super.listSuggestions(identity);
  }
  /** Separate credential boundary for guest-only HTTP sparse table allocation. */
  async guestEnsureDeckCell(
    input: import("@repo/protocol/deck").EnsureDeckCellInput,
    sessionToken: string
  ) {
    const scope = await this.state.storage.get<RoomScope>("productionScope");
    if (!scope || scope.artifactId !== input.artifactId) {
      throw new Error("Wrong scope");
    }
    const access = createGuestArtifacts({
      ...this.composed(),
      guestsOff: () =>
        Boolean(
          (this.productionEnv as Env & { LIVE_GUESTS_OFF?: string })
            .LIVE_GUESTS_OFF
        ),
    });
    const row = await access.sessionReference({ ...scope, sessionToken });
    if (row?.role !== "editor") {
      throw new Error("Guest access unavailable");
    }
    const ref = crypto.randomUUID();
    await this.state.storage.put(`credential:${ref}`, {
      expiresAt: Date.now() + 900_000,
      guest: { ...scope, sessionId: row.sessionId },
    } satisfies Credential);
    const identity = {
      authorizationRef: ref,
      kind: "guest" as const,
      participantId: `g:${row.guestId}`,
    };
    await this.state.storage.put(`actor:${identity.participantId}`, ref);
    return super.ensureDeckCellOutcome(input, identity);
  }
  /** Trusted RPC only: caller has already resolved a real principal. Never
   * exposed as an HTTP endpoint and never accepts ticket identity claims. */
  async registerActor(principal: Principal) {
    const live = requiredLive(this.composed().services);
    const current = await live.refreshTrustedPrincipal(principal);
    const scope = await this.state.storage.get<RoomScope>("productionScope");
    if (!scope || current.workspaceId !== scope.workspaceId) {
      throw new Error("Wrong workspace");
    }
    const identity = await live.roomIdentity(current, scope.artifactId);
    await this.state.storage.put(
      `actorName:${participant(current)}`,
      identity.name
    );
    const ref = crypto.randomUUID();
    await this.state.storage.put(`credential:${ref}`, {
      expiresAt: Date.now() + 15 * 60_000,
      principal: current,
    } satisfies Credential);
    await this.state.storage.put(`acceptedActor:${ref}`, current);
    await this.state.storage.put(`actor:${participant(current)}`, ref);
    if (identity.role === "owner" || identity.role === "editor") {
      await this.state.storage.put("checkpointActor", ref);
    }
    return ref;
  }
  async edit(ops: Operation[], origin: LiveOperationOrigin, summary: string) {
    const before = await this.read();
    new RoomStorage(this.state.storage).put(
      `productionChange:${origin.changeId}`,
      {
        createdAt: new Date().toISOString(),
        name: await this.state.storage.get<string>(
          `actorName:${origin.participantId}`
        ),
        ...new RoomStorage(this.state.storage).get<Record<string, unknown>>(
          `productionChange:${origin.changeId}`
        ),
        revFrom: before.revision,
        summary,
      }
    );
    return this.applyAgentOps(ops, origin);
  }
  async checkpointCanonical(snapshot: DocumentSnapshot) {
    const current = await super.authoritativeSnapshot();
    if (
      current.revision !== snapshot.revision ||
      current.state.length !== snapshot.state.length ||
      !current.state.every((b, i) => b === snapshot.state[i])
    ) {
      throw new Error("Checkpoint must match the current authoritative room");
    }
    return this.checkpoint();
  }
  async checkpointIfDue() {
    const store = new RoomStorage(this.state.storage);
    const meta = store.get<{ dirtySince: number | null }>("state");
    const pending = store.get<{ retryAt?: number }>("pending");
    if (
      pending ||
      (typeof meta?.dirtySince === "number" &&
        meta.dirtySince + 300_000 <= Date.now())
    ) {
      await super.checkpoint();
    }
  }
  private async scheduleRefresh() {
    if (!this.state.getWebSockets().length) {
      return;
    }
    const alarm = await this.state.storage.getAlarm();
    const deadline = Date.now() + 2000;
    if (alarm === null || alarm > deadline) {
      await this.state.storage.setAlarm(deadline);
    }
  }
  override async fetch(request: Request) {
    try {
      return await super.fetch(request);
    } finally {
      await this.scheduleRefresh();
    }
  }
  override async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer
  ) {
    try {
      await super.webSocketMessage(socket, message);
      const attachment = socket.deserializeAttachment() as Record<
        string,
        unknown
      >;
      socket.serializeAttachment({ ...attachment, receivedAt: Date.now() });
    } finally {
      await this.scheduleRefresh();
    }
  }
  override async alarm() {
    try {
      await super.refresh();
      await super.alarm();
    } finally {
      await this.scheduleRefresh();
    }
  }
}
