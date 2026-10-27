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
import type { DocumentSnapshot } from "@repo/services/live-artifacts/service";
import { type Principal, SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { applyUpdate, Doc } from "yjs";
import { type Composed, compose } from "../compose";
import { ArtifactRoom as Room } from "./artifact-room";
import { authenticateRoomRequest, freshMember } from "./auth";
import { roomName } from "./namespace";
import { findBlock, translateOperation } from "./operations";
import type { ArtifactRoomService, RoomScope } from "./ports";
import { requiredLive } from "./required";
import { RoomStorage } from "./storage";

interface Credential {
  expiresAt: number;
  principal?: Principal;
  request?: { url: string; headers: [string, string][] };
}
const participant = (principal: Principal) => {
  if (principal.kind === "user") {
    return `u:${principal.userId}`;
  }
  if (principal.kind === "run") {
    return `a:${principal.agentId}:${principal.runId}`;
  }
  return "";
};
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
      if (!credential || credential.expiresAt <= Date.now()) {
        return null;
      }
      if (credential.request) {
        return authenticateRoomRequest(
          env,
          get(),
          new Request(credential.request.url, {
            headers: credential.request.headers,
          })
        );
      }
      const { principal } = credential;
      if (!principal) {
        return null;
      }
      const refreshed = await live().refreshTrustedPrincipal(principal);
      if (refreshed.kind === "user") {
        const member = await freshMember(
          env,
          get(),
          refreshed.workspaceId,
          refreshed.userId
        );
        return member
          ? { ...refreshed, isAdmin: refreshed.apiKey ? false : member.isAdmin }
          : null;
      }
      return refreshed;
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
        if (identity.kind !== subject.kind) {
          return null;
        }
        if (identity.role === "owner" || identity.role === "editor") {
          await ctx.storage.put("checkpointActor", ref);
        }
        return { ...identity, authorizationRef: ref };
      } catch {
        return null;
      }
    };
    const service: ArtifactRoomService = {
      admit: async (scope, ticket, context) => {
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
          authorizationRef = crypto.randomUUID();
          const headers: [string, string][] = [];
          for (const name of ["authorization", "cookie"]) {
            const value = context.request.headers.get(name);
            if (value) {
              headers.push([name, value]);
            }
          }
          const url = new URL(context.request.url);
          url.search = "";
          await ctx.storage.put(`credential:${authorizationRef}`, {
            expiresAt: Date.now() + 15 * 60_000,
            request: { headers, url: url.toString() },
          } satisfies Credential);
          await ctx.storage.put(
            `actor:${participant(principal)}`,
            authorizationRef
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
      protectedRanges: async (scope) =>
        (await live().roomPolicy(SYSTEM_PRINCIPAL, scope)).ranges,
      save: async (scope, input) => {
        const ref = input.restores.at(-1)
          ? await ctx.storage.get<string>(
              `actor:${input.restores.at(-1)?.byParticipant}`
            )
          : await ctx.storage.get<string>("checkpointActor");
        const principal = ref ? await resolve(ref) : null;
        if (!principal) {
          throw new Error(
            "Checkpoint requires a current authorized credential"
          );
        }
        const store = new RoomStorage(ctx.storage);
        const origins = input.origins.map((origin) => {
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
        });
        const result = await live().durableCheckpoint(principal, {
          ...scope,
          ...input,
          origins,
        });
        await ctx.storage.delete("currentRestore");
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
  }) {
    let requestId = await this.state.storage.get<string>("currentRestore");
    if (!requestId) {
      requestId = crypto.randomUUID();
      await this.state.storage.put("currentRestore", requestId);
    }
    return super.restore({ ...input, requestId });
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
      store.get<Array<{ revision: number; blocks: Block[] }>>(
        "productionHistory"
      ) ?? [];
    if (!history.some((h) => h.revision === result.revision)) {
      history.push({
        blocks: result.content.blocks,
        revision: result.revision,
      });
      store.put("productionHistory", history.slice(-100));
    }
    const chosen =
      input.atRev === undefined || input.atRev === result.revision
        ? result.content
        : history.find((h) => h.revision === input.atRev);
    if (!chosen) {
      throw new DocumentError("revision_gone");
    }
    const older =
      input.sinceRev === undefined
        ? undefined
        : history.find((h) => h.revision === input.sinceRev);
    if (
      input.sinceRev !== undefined &&
      !older &&
      input.sinceRev !== result.revision
    ) {
      throw new DocumentError("revision_gone");
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
      deletedBlockIds:
        older?.blocks
          .filter((b) => !chosen.blocks.some((current) => current.id === b.id))
          .map((b) => b.id) ?? [],
      present: result.present,
      revision: chosen.revision,
    };
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
      return live.anchor(block.id, start, start + input.quote.length);
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
    if (store.get(`change:${origin.changeId}`)) {
      const result = await super.applyAgentOps([], origin);
      return { ok: true as const, ...result };
    }
    const { live, meta } = await this.snapshotController();
    store.put(key, {
      ops: JSON.stringify(ops),
      revFrom: meta.revision,
      summary,
    });
    try {
      const translated: Operation[] = [];
      for (const op of ops) {
        const target =
          op.target && "blockId" in op.target ? op.target : undefined;
        if (
          target &&
          "ifRev" in target &&
          target.ifRev !== meta.blockRevisions[target.blockId]
        ) {
          throw new DocumentError(
            "guard_mismatch",
            live.read().blocks.find((b) => b.id === target.blockId)
          );
        }
        const engineOp = translateOperation(live, op);
        translated.push(engineOp);
        const trialOp = structuredClone(engineOp);
        if ("ifRev" in trialOp) {
          let id: string | undefined;
          if ("blockId" in trialOp) {
            id = trialOp.blockId;
          } else if ("target" in trialOp && "blockId" in trialOp.target) {
            id = trialOp.target.blockId;
          }
          if (id) {
            trialOp.ifRev = live
              .read()
              .blocks.find((b) => b.id === id)?.revision;
          }
        }
        live.apply([trialOp], origin);
      }
      const result = await this.edit(translated, origin, summary);
      await this.documentRead({});
      return { ok: true as const, ...result };
    } catch (error) {
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
  private imageTail: Promise<unknown> = Promise.resolve();
  registerImage(fileId: string) {
    const result = this.imageTail.then(async () => {
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
    this.imageTail = result.catch(() => undefined);
    return result;
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
  /** Trusted RPC only: caller has already resolved a real principal. Never
   * exposed as an HTTP endpoint and never accepts ticket identity claims. */
  async registerActor(principal: Principal) {
    const live = requiredLive(this.composed().services);
    const current = await live.refreshTrustedPrincipal(principal);
    const scope = await this.state.storage.get<RoomScope>("productionScope");
    if (!scope || current.workspaceId !== scope.workspaceId) {
      throw new Error("Wrong workspace");
    }
    await live.roomIdentity(current, scope.artifactId);
    const ref = crypto.randomUUID();
    await this.state.storage.put(`credential:${ref}`, {
      expiresAt: Date.now() + 15 * 60_000,
      principal: current,
    } satisfies Credential);
    await this.state.storage.put(`actor:${participant(current)}`, ref);
    return ref;
  }
  async edit(ops: Operation[], origin: LiveOperationOrigin, summary: string) {
    const before = await this.read();
    new RoomStorage(this.state.storage).put(
      `productionChange:${origin.changeId}`,
      {
        ...new RoomStorage(this.state.storage).get<Record<string, unknown>>(
          `productionChange:${origin.changeId}`
        ),
        revFrom: before.revision,
        summary,
      }
    );
    return this.applyAgentOps(ops, origin);
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
