import { type Context, Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import { createDb } from "#/db/client";
import { getAgentById } from "#/modules/agents/service";
import { fromBase64 } from "./desktop";
import {
  type Failure,
  LEASE_REQUIRED_MESSAGE,
  relayFailure,
} from "./desktop-failure";
import { getHostByIdUnscoped } from "./hosts";
import {
  DESKTOP_CLIPBOARD_TIMEOUT_MS,
  DESKTOP_SCREENSHOT_TIMEOUT_MS,
  DesktopClipboardGetResultPayloadSchema,
  DesktopClipboardTextSchema,
  DesktopInputRequestSchema,
  DesktopScreenshotResultPayloadSchema,
  desktopInputTimeoutMs,
} from "./protocol";
import type { ComputerPrincipal, ComputerRelay, RelayStatus } from "./relay";
import {
  type CancelTakeoverHook,
  onCancelTakeover as defaultOnCancelTakeover,
  onHandBack as defaultOnHandBack,
  pendingTakeoverOf as defaultPendingTakeoverOf,
  type HandBackHook,
  type PendingTakeoverOf,
} from "./takeover-hook";
import {
  desktopStatusBody,
  VIEWER_PATH,
  VIEWER_USER_HEADER,
} from "./viewer-hub";

/**
 * A person's view of an agent's desktop: watch it, take control, type, share
 * the clipboard, and hand it back. Mounted under `workspaceScopedRoutes`, so the
 * caller is a member of the agent's workspace. The relay decides the lease on
 * the signed-in person, never on anything the client sent.
 */

const BAD_REPLY =
  "The computer sent a reply this server cannot read. Check that its version matches this deployment.";
const NOTE_MAX_CHARS = 2000;

/** The part of the relay stub these routes use; a fake in tests is just these five. */
export type DesktopRelayPort = Pick<
  ComputerRelay,
  "fetch" | "releaseHumanLease" | "request" | "status" | "takeHumanLease"
>;

export interface DesktopRouteDeps {
  /** The host the agent of this workspace runs its computer on, or undefined. */
  findAgentHost: (
    env: Env,
    workspaceId: string,
    agentId: string
  ) => Promise<{ id: string } | undefined>;
  onCancelTakeover: CancelTakeoverHook;
  onHandBack: HandBackHook;
  pendingTakeoverOf: PendingTakeoverOf;
  /** The relay of one host. Production reads its Durable Object. */
  relayFor: (env: Env, hostId: string) => DesktopRelayPort;
}

const findHostOfAgent: DesktopRouteDeps["findAgentHost"] = async (
  env,
  workspaceId,
  agentId
) => {
  const db = createDb(env.DB);
  const agent = await getAgentById(db, workspaceId, agentId);
  if (!agent?.computerHostId) {
    return;
  }
  return await getHostByIdUnscoped(db, agent.computerHostId);
};

/** The agent a `/:id` route names. The route pattern guarantees the id is there. */
const agentIdOf = (c: Context<ApiEnv>): string => {
  const id = c.req.param("id");
  if (!id) {
    throw new Error("A route under /:id has no agent id.");
  }
  return id;
};

const relayOfHost = (env: Env, hostId: string): DesktopRelayPort =>
  env.COMPUTER_RELAY.get(env.COMPUTER_RELAY.idFromName(hostId));

const InputBodySchema = z.object({
  actions: DesktopInputRequestSchema.shape.actions,
});
const ClipboardBodySchema = z.object({ text: DesktopClipboardTextSchema });
const HandBackBodySchema = z.object({
  note: z.string().max(NOTE_MAX_CHARS).optional(),
});

const BAD_REPLY_FAILURE: Failure = {
  error: "desktop_failed",
  message: BAD_REPLY,
  status: 502,
};

const parseJson = (json: string | null): unknown => {
  try {
    return JSON.parse(json ?? "null");
  } catch {
    return null;
  }
};

const parseBody = <T extends z.ZodType>(
  schema: T,
  raw: unknown
): z.infer<T> | undefined => {
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
};

const originOf = (url: string | undefined): string | null => {
  if (url === undefined) {
    return null;
  }
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/**
 * Cookies ride along on a request another site makes the browser send; a bearer
 * header cannot. So a write without one must come from this server's own origin,
 * or from PUBLIC_APP_URL when the request reached it through another host.
 */
const isForeignOriginWrite = (c: Context<ApiEnv>): boolean => {
  if (c.req.header("Authorization")?.startsWith("Bearer ")) {
    return false;
  }
  const caller = originOf(c.req.header("Origin"));
  if (caller === null) {
    return true;
  }
  return (
    caller !== originOf(c.req.url) && caller !== originOf(c.env.PUBLIC_APP_URL)
  );
};

const failureResponse = (c: Context<ApiEnv>, failure: Failure) =>
  c.json({ error: failure.error, message: failure.message }, failure.status);

const jpeg = (
  c: Context<ApiEnv>,
  bytes: Uint8Array<ArrayBuffer>,
  serverTiming?: string
) =>
  c.body(bytes, 200, {
    "Cache-Control": "no-store",
    "Content-Type": "image/jpeg",
    ...(serverTiming === undefined ? {} : { "Server-Timing": serverTiming }),
    "X-Content-Type-Options": "nosniff",
  });

/** A fresh JPEG of the desktop, as the person asks for it. */
const frameOf = async (
  relay: DesktopRelayPort,
  principal: ComputerPrincipal
): Promise<
  { bytes: Uint8Array<ArrayBuffer>; ok: true } | { failure: Failure; ok: false }
> => {
  const outcome = await relay.request(
    {
      op: "desktop_screenshot",
      quality: null,
      timeout_ms: DESKTOP_SCREENSHOT_TIMEOUT_MS,
    },
    principal
  );
  if (!outcome.ok) {
    return { failure: relayFailure(outcome), ok: false };
  }
  const payload = DesktopScreenshotResultPayloadSchema.safeParse(
    parseJson(outcome.result_json)
  );
  if (!payload.success) {
    return { failure: BAD_REPLY_FAILURE, ok: false };
  }
  return { bytes: fromBase64(payload.data.data_b64), ok: true };
};

export const createDesktopRoutes = (
  deps: Partial<DesktopRouteDeps> = {}
): Hono<ApiEnv> => {
  const findAgentHost = deps.findAgentHost ?? findHostOfAgent;
  const relayFor = deps.relayFor ?? relayOfHost;
  const onHandBack = deps.onHandBack ?? defaultOnHandBack;
  const onCancelTakeover = deps.onCancelTakeover ?? defaultOnCancelTakeover;
  const pendingTakeoverOf = deps.pendingTakeoverOf ?? defaultPendingTakeoverOf;

  const routes = new Hono<ApiEnv>();
  routes.use("*", requireAuth);

  /** The relay of the computer the agent runs on; undefined when there is none to serve. */
  const relayOf = async (c: Context<ApiEnv>) => {
    const host = await findAgentHost(
      c.env,
      c.get("workspace").id,
      agentIdOf(c)
    );
    return host ? relayFor(c.env, host.id) : undefined;
  };
  const notFound = (c: Context<ApiEnv>) =>
    c.json({ error: "not_found", message: "No computer for this agent." }, 404);
  const personOf = (c: Context<ApiEnv>): ComputerPrincipal => ({
    kind: "human",
    userId: c.get("userId"),
  });
  /** A status answer, with the takeover the agent is waiting on. */
  const statusPayload = async (c: Context<ApiEnv>, status: RelayStatus) => ({
    ...desktopStatusBody(status, c.get("userId")),
    pendingTakeover: await pendingTakeoverOf(
      c.env,
      c.get("workspace").id,
      agentIdOf(c)
    ),
  });
  /** The takeover was settled by someone else first, or nothing waited to be settled. */
  const alreadyHandled = (c: Context<ApiEnv>) =>
    c.json(
      {
        error: "already_handled",
        message: "This takeover was already handled.",
      },
      409
    );

  routes.get("/:id/desktop", async (c) => {
    const relay = await relayOf(c);
    if (!relay) {
      return notFound(c);
    }
    return c.json(await statusPayload(c, await relay.status()));
  });

  routes.get("/:id/desktop/screenshot", async (c) => {
    const started = performance.now();
    const relay = await relayOf(c);
    if (!relay) {
      return notFound(c);
    }
    const asked = performance.now();
    const frame = await frameOf(relay, personOf(c));
    if (!frame.ok) {
      return failureResponse(c, frame.failure);
    }
    const done = performance.now();
    return jpeg(
      c,
      frame.bytes,
      `lookup;dur=${(asked - started).toFixed(1)}, relay;dur=${(done - asked).toFixed(1)}, total;dur=${(done - started).toFixed(1)}`
    );
  });

  /** The live view: a WebSocket of frames out and input in, served by the host's relay. */
  routes.get("/:id/desktop/stream", async (c) => {
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
      return c.json(
        { error: "upgrade_required", message: "Expected a WebSocket upgrade." },
        426
      );
    }
    // A browser always sends Origin on a WebSocket, and cookies ride along from any site.
    if (isForeignOriginWrite(c)) {
      return c.json(
        { error: "forbidden", message: "Cross-origin request refused." },
        403
      );
    }
    const relay = await relayOf(c);
    if (!relay) {
      return notFound(c);
    }
    // Built fresh: nothing the client sent, the viewer header included, reaches the relay.
    return await relay.fetch(
      new Request(new URL(VIEWER_PATH, "https://relay.internal"), {
        headers: {
          Upgrade: "websocket",
          [VIEWER_USER_HEADER]: c.get("userId"),
        },
      })
    );
  });

  routes.post("/:id/desktop/input", async (c) => {
    if (isForeignOriginWrite(c)) {
      return c.json(
        { error: "forbidden", message: "Cross-origin request refused." },
        403
      );
    }
    const body = parseBody(
      InputBodySchema,
      await c.req.json().catch(() => undefined)
    );
    if (!body) {
      return c.json(
        {
          error: "bad_request",
          message: "Expected a batch of desktop actions.",
        },
        400
      );
    }
    const relay = await relayOf(c);
    if (!relay) {
      return notFound(c);
    }
    const sent = await relay.request(
      {
        actions: body.actions,
        op: "desktop_input",
        timeout_ms: desktopInputTimeoutMs(body.actions),
      },
      personOf(c)
    );
    if (!sent.ok) {
      return failureResponse(c, relayFailure(sent));
    }
    const frame = await frameOf(relay, personOf(c));
    return frame.ok ? jpeg(c, frame.bytes) : failureResponse(c, frame.failure);
  });

  routes.get("/:id/desktop/clipboard", async (c) => {
    const relay = await relayOf(c);
    if (!relay) {
      return notFound(c);
    }
    const read = await relay.request(
      { op: "desktop_clipboard_get", timeout_ms: DESKTOP_CLIPBOARD_TIMEOUT_MS },
      personOf(c)
    );
    if (!read.ok) {
      return failureResponse(c, relayFailure(read));
    }
    const payload = DesktopClipboardGetResultPayloadSchema.safeParse(
      parseJson(read.result_json)
    );
    if (!payload.success) {
      return failureResponse(c, BAD_REPLY_FAILURE);
    }
    c.header("Cache-Control", "no-store");
    return c.json({ text: payload.data.text });
  });

  routes.put("/:id/desktop/clipboard", async (c) => {
    if (isForeignOriginWrite(c)) {
      return c.json(
        { error: "forbidden", message: "Cross-origin request refused." },
        403
      );
    }
    const body = parseBody(
      ClipboardBodySchema,
      await c.req.json().catch(() => undefined)
    );
    if (!body) {
      return c.json(
        {
          error: "bad_request",
          message: "Expected {text} with at most 64 KiB of text.",
        },
        400
      );
    }
    const relay = await relayOf(c);
    if (!relay) {
      return notFound(c);
    }
    const written = await relay.request(
      {
        op: "desktop_clipboard_set",
        selections: ["clipboard", "primary"],
        text: body.text,
        timeout_ms: DESKTOP_CLIPBOARD_TIMEOUT_MS,
      },
      personOf(c)
    );
    if (!written.ok) {
      return failureResponse(c, relayFailure(written));
    }
    return c.body(null, 204);
  });

  routes.post("/:id/desktop/take-control", async (c) => {
    if (isForeignOriginWrite(c)) {
      return c.json(
        { error: "forbidden", message: "Cross-origin request refused." },
        403
      );
    }
    const relay = await relayOf(c);
    if (!relay) {
      return notFound(c);
    }
    // Taking control of a machine that is not there would pause every agent on it for nothing.
    if (!(await relay.status()).connected) {
      return c.json(
        { error: "offline", message: "The computer is offline." },
        503
      );
    }
    const taken = await relay.takeHumanLease(c.get("userId"));
    if (!taken.ok) {
      const status = taken.reason === "desktop_busy" ? 409 : 503;
      const error =
        taken.reason === "desktop_busy" ? "clearing" : "desktop_unavailable";
      return c.json({ error, message: taken.message }, status);
    }
    return c.json(await statusPayload(c, await relay.status()));
  });

  routes.post("/:id/desktop/hand-back", async (c) => {
    if (isForeignOriginWrite(c)) {
      return c.json(
        { error: "forbidden", message: "Cross-origin request refused." },
        403
      );
    }
    const body = parseBody(
      HandBackBodySchema,
      await c.req.json().catch(() => ({}))
    );
    if (!body) {
      return c.json(
        {
          error: "bad_request",
          message: `A note is at most ${NOTE_MAX_CHARS} characters.`,
        },
        400
      );
    }
    const relay = await relayOf(c);
    if (!relay) {
      return notFound(c);
    }
    const userId = c.get("userId");
    const released = await relay.releaseHumanLease(userId);
    if (!released.released) {
      return c.json(
        { error: "lease_required", message: LEASE_REQUIRED_MESSAGE },
        423
      );
    }
    const outcome = await onHandBack({
      agentId: agentIdOf(c),
      env: c.env,
      note: body.note ?? null,
      userId,
      workspaceId: c.get("workspace").id,
    });
    if (outcome.kind === "already_handled") {
      return alreadyHandled(c);
    }
    return c.json(await statusPayload(c, await relay.status()));
  });

  routes.post("/:id/desktop/cancel-takeover", async (c) => {
    if (isForeignOriginWrite(c)) {
      return c.json(
        { error: "forbidden", message: "Cross-origin request refused." },
        403
      );
    }
    const outcome = await onCancelTakeover({
      agentId: agentIdOf(c),
      env: c.env,
      userId: c.get("userId"),
      workspaceId: c.get("workspace").id,
    });
    if (outcome.kind !== "settled") {
      return alreadyHandled(c);
    }
    return c.json({ question: outcome.question });
  });

  return routes;
};

export const desktopRoutes = createDesktopRoutes();
