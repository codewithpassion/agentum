import { ensureDeckCellInputSchema } from "@repo/protocol/deck";
import { type GuestOpenResult, guestCommentSchema } from "@repo/protocol/guest";
import type { GuestGrant } from "@repo/protocol/live";
import { signRoomTicket } from "@repo/services/live-artifacts/ticket";
import {
  createGuestArtifacts,
  type GuestCredential,
} from "@repo/services/live-guests/artifacts";
import { createGuestImages } from "@repo/services/live-guests/images";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import type { Composed } from "../compose";
import { readCappedBody } from "../mcp/body";
import { r2Blobs } from "../r2-blobs";
import { r2FileBlobs } from "../r2-files";
import { roomStub } from "./namespace";
import { requiredLive } from "./required";

export const guestJson = async (request: Request) => {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
    throw new Error("JSON required");
  }
  const body = await readCappedBody(request, 16_384);
  if (!body.ok) {
    throw new Error("Invalid body");
  }
  return JSON.parse(new TextDecoder().decode(body.bytes)) as unknown;
};
export const guestsOff = (env: Env) =>
  Boolean((env as Env & { LIVE_GUESTS_OFF?: string }).LIVE_GUESTS_OFF);
export const scopedGuests = (env: Env, composed: Composed) =>
  createGuestArtifacts({
    ...composed,
    anchors: {
      resolve: async (scope, anchor) =>
        (await roomStub(env.ARTIFACT_ROOM, scope)).resolveAnchor(anchor),
    },
    events: composed.services.events,
    guestsOff: () => guestsOff(env),
    payloads: r2Blobs(env.FILES),
  });
export const guestImages = (env: Env, composed: Composed) =>
  createGuestImages({
    ...composed,
    blobs: r2FileBlobs(env.FILES),
    guestsOff: () => guestsOff(env),
    policy: async (scope) =>
      (
        await requiredLive(composed.services).roomPolicy(
          SYSTEM_PRINCIPAL,
          scope
        )
      ).ownBlobUrls,
    register: async (scope, id) =>
      (await roomStub(env.ARTIFACT_ROOM, scope)).registerImage(id),
  });
const requiredGuests = async (composed: Composed) => {
  const service = await composed.services.liveGuests?.();
  if (!service) {
    throw new Error("Guest access unavailable");
  }
  return service;
};
interface Input {
  composed: Composed;
  credential: GuestCredential;
  env: Env;
  grant: GuestGrant;
  request: Request;
}
const open = async ({
  env,
  composed,
  credential,
  grant,
}: Input): Promise<GuestOpenResult> => {
  const snapshot = await (
    await roomStub(env.ARTIFACT_ROOM, grant)
  ).authoritativeSnapshot();
  return {
    ...(await scopedGuests(env, composed).metadata(credential)),
    ...(await (await requiredGuests(composed)).details(credential)),
    revision: snapshot.revision,
    state: [...snapshot.state],
  };
};
const join = async ({ env, composed, grant, credential }: Input) => {
  await env.LIVE_ARTIFACT_MAINTENANCE.getByName("maintenance").start();
  const details = await (await requiredGuests(composed)).details(credential);
  const now = Math.floor(composed.clock.now().getTime() / 1000);
  const identity = {
    color: "#059669",
    kind: "guest" as const,
    name: details?.guestName.slice(0, 200) || "Guest",
    participantId: `g:${grant.guestId}`,
    role: grant.role,
  };
  const ticket = await signRoomTicket(
    {
      ...identity,
      artifactId: grant.artifactId,
      audience: "artifact-room",
      connectionExpiresAt: Math.min(
        now + 900,
        Math.floor(new Date(grant.expiresAt).getTime() / 1000)
      ),
      expiresAt: Math.min(
        now + 120,
        Math.floor(new Date(grant.expiresAt).getTime() / 1000)
      ),
      issuedAt: now,
      jti: crypto.randomUUID(),
      version: 1,
      workspaceId: grant.workspaceId,
    },
    env.ARTIFACT_VIEW_KEY ? `artifact-room:${env.ARTIFACT_VIEW_KEY}` : ""
  );
  return {
    participant: {
      color: identity.color,
      id: identity.participantId,
      kind: identity.kind,
      name: identity.name,
    },
    role: grant.role,
    roomUrl: `/api/guest/artifacts/${grant.artifactId}/room`,
    ticket,
  };
};
const images = async ({ env, composed, credential, request }: Input) => {
  const capped = await readCappedBody(request, 8 * 1024 * 1024 + 65_536);
  if (!capped.ok) {
    throw new Error("Invalid image");
  }
  const form = await new Request(request.url, {
    body: capped.bytes,
    headers: request.headers,
    method: "POST",
  }).formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new Error("Expected file");
  }
  return guestImages(env, composed).upload(credential, file, file.name);
};
export const guestActions: Record<
  string,
  { method: string; execute: (input: Input) => Promise<unknown> }
> = {
  comment: {
    execute: async ({ env, composed, credential, request }) =>
      scopedGuests(env, composed).comment(
        credential,
        guestCommentSchema.parse(await guestJson(request))
      ),
    method: "POST",
  },
  "ensure-deck-cell": {
    execute: async ({ env, grant, credential, request }) => {
      const body = await guestJson(request);
      const input = ensureDeckCellInputSchema.parse({
        ...(body as object),
        artifactId: grant.artifactId,
      });
      const result = await (
        await roomStub(env.ARTIFACT_ROOM, grant)
      ).guestEnsureDeckCell(input, credential.sessionToken);
      if (!result.ok) {
        throw new Error("Guest access unavailable");
      }
      return {
        revision: result.result.revision,
        state: [...result.result.state],
      };
    },
    method: "POST",
  },
  images: { execute: images, method: "POST" },
  join: { execute: join, method: "POST" },
  open: { execute: open, method: "GET" },
  policy: {
    execute: async ({ composed, grant }) =>
      requiredLive(composed.services).roomPolicy(SYSTEM_PRINCIPAL, grant),
    method: "GET",
  },
  resolve: {
    execute: async ({ env, composed, credential, request }) => {
      const body = (await guestJson(request)) as { threadId?: unknown };
      if (
        typeof body.threadId !== "string" ||
        !body.threadId ||
        body.threadId.length > 200
      ) {
        throw new Error("Invalid thread");
      }
      return scopedGuests(env, composed).resolve(credential, body.threadId);
    },
    method: "POST",
  },
  rotate: {
    execute: ({ grant }) => Promise.resolve({ grant }),
    method: "POST",
  },
  session: {
    execute: async ({ env, composed, credential, request }) =>
      scopedGuests(env, composed).transcript(
        credential,
        new URL(request.url).searchParams.get("after")?.slice(0, 200)
      ),
    method: "GET",
  },
  threads: {
    execute: async ({ env, composed, credential }) =>
      scopedGuests(env, composed).threads(credential),
    method: "GET",
  },
};
