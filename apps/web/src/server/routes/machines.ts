// Machine HTTP routes: the one-time enrol, the sockets a daemon and a computer
// client dial (`/connect` and `/computer`) and the run calls (machine-runs.ts).
// All are bearer-authenticated, so the group has no csrf check. Mount with
// `runtimeRoutes.route("/api/machines", machineRoutes())`.
import {
  CLOSE_CODES,
  enrollResponseSchema,
  machineEnrollRequestSchema,
} from "@repo/protocol/machine";
import type { AuthenticateRole } from "@repo/services/machines";
import type { Context } from "hono";
import {
  RELAY_HEADER_MACHINE_ID,
  RELAY_HEADER_ROLE,
  RELAY_HEADER_WORKSPACE_ID,
  type RelayRole,
} from "../relay-core.ts";
import { type AppEnv, bearerGroup } from "./groups.ts";
import { machineRunRoutes } from "./machine-runs.ts";

const UPGRADE_REQUIRED = 426;

/** The only client headers that reach the relay. The rest, Authorization included, stay here. */
export const UPGRADE_HEADERS = [
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

/**
 * Hands a WebSocket upgrade to the machine's relay. `authRole` says which
 * credential opens it and `relayRole` says which socket the relay holds, so a
 * daemon credential never opens the computer socket and the reverse.
 */
const upgradeToRelay = async (
  c: Context<AppEnv>,
  authRole: AuthenticateRole,
  relayRole: RelayRole
): Promise<Response> => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "Expected a WebSocket upgrade." }, UPGRADE_REQUIRED);
  }
  const principal = await c
    .get("composed")
    .services.machines.authenticate(
      c.req.header("Authorization") ?? null,
      authRole
    );
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
  headers.set(RELAY_HEADER_ROLE, relayRole);
  const stub = c.env.MACHINE_RELAY.get(
    c.env.MACHINE_RELAY.idFromName(principal.machineId)
  );
  return stub.fetch(new Request(c.req.url, { headers, method: "GET" }));
};

export const machineRoutes = () => {
  const machines = bearerGroup();

  machines.post("/enroll", async (c) => {
    const body = await c.req.json().then(
      (raw: unknown) => machineEnrollRequestSchema.safeParse(raw),
      () => null
    );
    if (!body?.success) {
      return c.json(
        {
          error:
            "Expected JSON with a code and singleUser, or a computer body with role computer.",
        },
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

  machines.get("/connect", (c) => upgradeToRelay(c, "agent_host", "daemon"));

  machines.get("/computer", (c) => upgradeToRelay(c, "computer", "computer"));

  machines.route("/runs", machineRunRoutes());

  return machines;
};
