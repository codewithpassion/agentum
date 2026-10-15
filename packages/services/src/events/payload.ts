import { z } from "zod";

export const PAYLOAD_MAX_BYTES = 65_536;
export const payloadRefSchema = z.strictObject({
  bytes: z.number().int().safe().min(0),
  key: z.string().max(512).startsWith("payloads/"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type PayloadRef = z.infer<typeof payloadRefSchema>;

// Bound traversal before recursive JSON validation or serialization can overflow.
const checkedPayload = z.unknown().transform((value, ctx) => {
  const stack = [{ depth: 0, value }];
  let nodes = 0;
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) {
      break;
    }
    nodes += 1;
    if (entry.depth > 64 || nodes > 100_000) {
      ctx.addIssue({
        code: "custom",
        message: "Payload exceeds depth 64 or 100,000 nodes",
      });
      return z.NEVER;
    }
    if (entry.value !== null && typeof entry.value === "object") {
      for (const key of Object.keys(entry.value)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) {
          ctx.addIssue({
            code: "custom",
            message: "Payload contains a reserved key",
          });
          return z.NEVER;
        }
        stack.push({
          depth: entry.depth + 1,
          value: (entry.value as Record<string, unknown>)[key],
        });
      }
    }
  }
  return value;
});

export const payloadSchema = checkedPayload.pipe(
  z.record(z.string(), z.json())
);
export type Payload = z.infer<typeof payloadSchema>;
export interface CappedPayload {
  payload: Record<string, unknown>;
  payload_ref: PayloadRef | null;
}

// Callers should use payloads/<yyyy>/<mm>/<dd>/<client_id>/<event id>-<first 16 hex of sha256>.json as the key.
export async function capPayload(
  payload: Record<string, unknown>,
  options: {
    store: (key: string, body: string) => Promise<unknown>;
    key: string;
  }
): Promise<CappedPayload> {
  const parsed = payloadSchema.parse(payload);
  const body = JSON.stringify(parsed);
  const encoded = new TextEncoder().encode(body);
  if (encoded.byteLength <= PAYLOAD_MAX_BYTES) {
    return { payload: parsed, payload_ref: null };
  }
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  const payload_ref = payloadRefSchema.parse({
    bytes: encoded.byteLength,
    key: options.key,
    sha256,
  });
  await options.store(options.key, body);
  return { payload: {}, payload_ref };
}
