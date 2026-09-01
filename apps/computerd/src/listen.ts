/**
 * Listen mode: the daemon answers HTTP on a port. This is how a Fly Machine is
 * reached - Agentum posts to `https://<app>.fly.dev/op` with the host token and
 * `fly-force-instance-id`, and the Fly proxy starts the machine if it was
 * stopped.
 *
 * The error contract is deliberately flat: 401 when the token is wrong, and 200
 * with `{ id, result }` for everything else, failures included. That is the same
 * envelope connect mode puts on the wire, so Agentum's client has one shape to
 * parse whichever transport it is on.
 */

import type { Handle } from "./handlers";
import { isAuthorized } from "./token";
import { VERSION } from "./version";

export interface ListenOptions {
  handle: Handle;
  /** 0 asks the OS for an ephemeral port, which is what the tests use. */
  port: number;
  tokenHash: string;
}

const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;

const failure = (reason: string, status?: number) =>
  Response.json({ id: "", result: { ok: false, reason } }, { status });

export const startListenServer = (
  options: ListenOptions
): Bun.Server<undefined> =>
  Bun.serve({
    development: false,
    async fetch(request) {
      const { pathname } = new URL(request.url);

      // Unauthenticated on purpose: this is what a container orchestrator polls,
      // and it says nothing a caller could not learn by connecting.
      if (pathname === "/healthz" && request.method === "GET") {
        return Response.json({ ok: true, version: VERSION });
      }

      if (pathname !== "/op" || request.method !== "POST") {
        return failure(
          "Not found. The daemon serves GET /healthz and POST /op.",
          HTTP_NOT_FOUND
        );
      }

      if (
        !(await isAuthorized(
          request.headers.get("authorization"),
          options.tokenHash
        ))
      ) {
        return failure("Unauthorized.", HTTP_UNAUTHORIZED);
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return failure("The request body must be JSON.");
      }
      return Response.json(await options.handle(body));
    },
    port: options.port,
  });
