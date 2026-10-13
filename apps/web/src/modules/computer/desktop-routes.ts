import { type Context, Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import { createDb } from "#/db/client";
import { getAgentById } from "#/modules/agents/service";
import { fromBase64 } from "./desktop";
import { getHostByIdUnscoped } from "./hosts";
import {
  CLIENT_ERROR_DESKTOP_UNAVAILABLE,
  DESKTOP_CLIPBOARD_TIMEOUT_MS,
  DESKTOP_SCREENSHOT_TIMEOUT_MS,
  DesktopClipboardGetResultPayloadSchema,
  DesktopClipboardTextSchema,
  DesktopInputRequestSchema,
  DesktopScreenshotResultPayloadSchema,
  desktopInputTimeoutMs,
} from "./protocol";
import type {
  ComputerPrincipal,
  ComputerRelay,
  RelayOutcome,
  RelayStatus,
} from "./relay";
import {
  onHandBack as defaultOnHandBack,
  type HandBackHook,
} from "./takeover-hook";

/**
 * A person's view of an agent's desktop: watch it, take control, type, share
 * the clipboard, and hand it back. Mounted under `workspaceScopedRoutes`, so the
 * caller is a member of the agent's workspace. The relay decides the lease on
 * the signed-in person, never on anything the client sent.
 */

const BAD_REPLY =
  "The computer sent a reply this server cannot read. Check that its version matches this deployment.";
const LEASE_REQUIRED_MESSAGE = "Take control of the desktop first.";
const NOTE_MAX_CHARS = 2000;

/** The part of the relay stub these routes use; a fake in tests is just these four. */
export type DesktopRelayPort = Pick<
  ComputerRelay,
  "releaseHumanLease" | "request" | "status" | "takeHumanLease"
>;

export interface DesktopRouteDeps {
  /** The host the agent of this workspace runs its computer on, or undefined. */
  findAgentHost: (
    env: Env,
    workspaceId: string,
    agentId: string
  ) => Promise<{ id: string } | undefined>;
  onHandBack: HandBackHook;
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

/** What a route answers a failed relay op with: the status, and the code the UI branches on. */
interface Failure {
  readonly error: string;
  readonly message: string;
  readonly status: 409 | 423 | 502 | 503;
}

const relayFailure = (outcome: RelayOutcome): Failure => {
  switch (outcome.reason) {
    case "human_in_control":
      return {
        error: "human_in_control",
        message: outcome.message,
        status: 423,
      };
    case "forbidden":
      return {
        error: "lease_required",
        message: LEASE_REQUIRED_MESSAGE,
        status: 423,
      };
    case "desktop_busy":
      return { error: "clearing", message: outcome.message, status: 409 };
    case "desktop_unavailable":
      return {
        error: "desktop_unavailable",
        message: outcome.message,
        status: 503,
      };
    case "client_error":
      if (outcome.code === CLIENT_ERROR_DESKTOP_UNAVAILABLE) {
        return {
          error: "desktop_unavailable",
          message: outcome.message,
          status: 503,
        };
      }
      return { error: "desktop_failed", message: outcome.message, status: 502 };
    default:
      return { error: "offline", message: outcome.message, status: 503 };
  }
};

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

/** Whether the signed-in person is the one holding the desktop right now. */
const youHold = (status: RelayStatus, userId: string): boolean => {
  const { control } = status;
  return (
    control !== null &&
    control.holder.kind === "human" &&
    control.holder.userId === userId
  );
};

const statusBody = (status: RelayStatus, userId: string) => ({
  connected: status.connected,
  control: status.control,
  desktop: status.capabilities?.desktop === true,
  desktopUnavailableReason:
    status.capabilities?.desktop_unavailable_reason ?? null,
  youHaveControl: youHold(status, userId),
});

const failureResponse = (c: Context<ApiEnv>, failure: Failure) =>
  c.json({ error: failure.error, message: failure.message }, failure.status);

const jpeg = (c: Context<ApiEnv>, bytes: Uint8Array<ArrayBuffer>) =>
  c.body(bytes, 200, {
    "Cache-Control": "no-store",
    "Content-Type": "image/jpeg",
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

  routes.get("/:id/desktop", async (c) => {
    const relay = await relayOf(c);
    if (!relay) {
      return notFound(c);
    }
    return c.json(statusBody(await relay.status(), c.get("userId")));
  });

  routes.get("/:id/desktop/screenshot", async (c) => {
    const relay = await relayOf(c);
    if (!relay) {
      return notFound(c);
    }
    const frame = await frameOf(relay, personOf(c));
    return frame.ok ? jpeg(c, frame.bytes) : failureResponse(c, frame.failure);
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
    return c.json(statusBody(await relay.status(), c.get("userId")));
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
    await onHandBack({
      agentId: agentIdOf(c),
      note: body.note ?? null,
      userId,
      workspaceId: c.get("workspace").id,
    });
    return c.json(statusBody(await relay.status(), userId));
  });

  return routes;
};

export const desktopRoutes = createDesktopRoutes();
