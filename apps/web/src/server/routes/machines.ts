// Machine HTTP routes: the one-time enrol, the socket a daemon dials and the
// run calls (machine-runs.ts). All are bearer-authenticated, so the group has
// no csrf check. Mount with
// `runtimeRoutes.route("/api/machines", machineRoutes())`.
import {
  CLOSE_CODES,
  enrollRequestSchema,
  enrollResponseSchema,
} from "@repo/protocol/machine";
import {
  RELAY_HEADER_MACHINE_ID,
  RELAY_HEADER_WORKSPACE_ID,
} from "../relay-core.ts";
import { bearerGroup } from "./groups.ts";
import { machineRunRoutes } from "./machine-runs.ts";

const UPGRADE_REQUIRED = 426;

/** The only client headers that reach the relay. The rest, Authorization included, stay here. */
const UPGRADE_HEADERS = [
  "connection",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "upgrade",
] as const;

/**
 * A refusal is never an HTTP status. A client that asked for an upgrade and
 * got 401 sees only "expected 101", which looks like a deploy blip, so it
 * would retry a credential that is gone. The upgrade is accepted and closed at
 * once with 4401, which the daemon reads as "stop".
 */
export const refuseSocket = (): Response => {
  // biome-ignore lint/correctness/noUndeclaredVariables: WebSocketPair is a Workers runtime global
  const pair = new WebSocketPair();
  // biome-ignore lint/style/useDestructuring: WebSocketPair is an indexed object, not an iterable
  const server = pair[1];
  server.accept();
  server.close(CLOSE_CODES.credentialRejected, "credential rejected");
  return new Response(null, { status: 101, webSocket: pair[0] });
};

export const machineRoutes = () => {
  const machines = bearerGroup();

  machines.post("/enroll", async (c) => {
    const body = await c.req.json().then(
      (raw: unknown) => enrollRequestSchema.safeParse(raw),
      () => null
    );
    if (!body?.success) {
      return c.json(
        { error: "Expected JSON with a code and singleUser." },
        400
      );
    }
    const enrolled = await c
      .get("composed")
      .services.machines.enroll(body.data);
    if (!enrolled) {
      return c.json(
        { error: "The enrolment code is invalid, expired or already used." },
        401
      );
    }
    return c.json(enrollResponseSchema.parse(enrolled));
  });

  machines.get("/connect", async (c) => {
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
      return c.json(
        { error: "Expected a WebSocket upgrade." },
        UPGRADE_REQUIRED
      );
    }
    const principal = await c
      .get("composed")
      .services.machines.authenticate(c.req.header("Authorization") ?? null);
    if (!principal) {
      return refuseSocket();
    }
    const headers = new Headers();
    for (const name of UPGRADE_HEADERS) {
      const value = c.req.header(name);
      if (value !== undefined) {
        headers.set(name, value);
      }
    }
    // Set from the principal, so a client cannot spoof them.
    headers.set(RELAY_HEADER_MACHINE_ID, principal.machineId);
    headers.set(RELAY_HEADER_WORKSPACE_ID, principal.workspaceId);
    const stub = c.env.MACHINE_RELAY.get(
      c.env.MACHINE_RELAY.idFromName(principal.machineId)
    );
    return stub.fetch(new Request(c.req.url, { headers, method: "GET" }));
  });

  machines.route("/runs", machineRunRoutes());

  return machines;
};
