import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { generateConnectorKey } from "#/crypto";
import { signAttachmentLink } from "#/modules/messaging/attachment-links";
import { agentImageRoutes } from "./route";

const KEY = generateConnectorKey();
const IMAGE_KEY = "browser/agent-1/1700000000000-abcd.png";
const TEXT_KEY = "attachments/notes.txt";
const MISSING_KEY = "browser/agent-1/gone.png";

const fakeBucket = (): R2Bucket =>
  ({
    get: (key: string) => {
      if (key === IMAGE_KEY) {
        return Promise.resolve({
          body: "png-bytes",
          httpMetadata: { contentType: "image/png" },
          size: 9,
        });
      }
      if (key === TEXT_KEY) {
        return Promise.resolve({
          body: "hello",
          httpMetadata: { contentType: "text/plain" },
          size: 5,
        });
      }
      return Promise.resolve(null);
    },
  }) as unknown as R2Bucket;

const app = new Hono<{ Bindings: Env }>();
app.route("/api/agent-images", agentImageRoutes);

let env: Env;

beforeEach(() => {
  env = { ATTACHMENT_LINK_KEY: KEY, ATTACHMENTS: fakeBucket() } as Env;
});

const get = async (
  key: string,
  overrides: { exp?: string; sig?: string; now?: number } = {}
) => {
  const link = await signAttachmentLink(KEY, { id: key, now: overrides.now });
  const params = new URLSearchParams({
    exp: overrides.exp ?? String(link.expiresAt),
    key,
    sig: overrides.sig ?? link.signature,
  });
  return await app.request(`/api/agent-images?${params}`, {}, env);
};

describe("GET /api/agent-images", () => {
  test("serves an image with a valid signature", async () => {
    const response = await get(IMAGE_KEY);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(await response.text()).toBe("png-bytes");
  });

  test("refuses an expired link", async () => {
    const response = await get(IMAGE_KEY, { now: Date.now() - 2 * 3_600_000 });

    expect(response.status).toBe(404);
  });

  test("refuses a bad signature and an edited key", async () => {
    const forged = await get(IMAGE_KEY, { sig: "AAAA" });
    const other = await signAttachmentLink(KEY, { id: TEXT_KEY });
    const swapped = await app.request(
      `/api/agent-images?${new URLSearchParams({
        exp: String(other.expiresAt),
        key: IMAGE_KEY,
        sig: other.signature,
      })}`,
      {},
      env
    );

    expect(forged.status).toBe(404);
    expect(swapped.status).toBe(404);
  });

  test("answers the same for a missing object and a non-image", async () => {
    const missing = await get(MISSING_KEY);
    const text = await get(TEXT_KEY);
    const bad = await get(IMAGE_KEY, { sig: "AAAA" });

    expect(missing.status).toBe(404);
    expect(text.status).toBe(404);
    expect(await missing.json()).toEqual(await bad.json());
  });
});
