import { Hono } from "hono";
import { createDb } from "#/db/client";
import { redeemEnrollmentCode } from "./hosts";

/**
 * `POST /api/computer-hosts/enroll` - where a computer client trades its
 * single-use enrollment code for the machine credential it dials in with.
 * Outside `requireAuth`: the code is the credential.
 *
 * Request `{ enrollment_code, hostname, os, arch, version }`, response
 * `{ data: { computer_id, machine_credential } }`. Every failure - malformed
 * body, wrong code, expired, already redeemed - is the same bare 401, so a
 * caller cannot tell which it was.
 */

const UNAUTHORIZED = 401;

const reject = (c: { json: (body: unknown, status: 401) => Response }) =>
  c.json({ error: "Unauthorized." }, UNAUTHORIZED);

export const computerEnrollRoutes = new Hono<{ Bindings: Env }>();

computerEnrollRoutes.post("/enroll", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const code =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).enrollment_code
      : undefined;
  if (typeof code !== "string" || code.trim() === "") {
    return reject(c);
  }

  const redeemed = await redeemEnrollmentCode(createDb(c.env.DB), code.trim());
  if (!redeemed) {
    return reject(c);
  }
  return c.json({
    data: {
      computer_id: redeemed.host.id,
      machine_credential: redeemed.credential,
    },
  });
});
