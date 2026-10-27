import { expect, test } from "bun:test";
import { guestEmailAdapter } from "./guest-infra";
import { guestOpenMetadata } from "./guest-metadata";
import { guestStream } from "./guest-stream";

test("EMAIL adapter captures escaped HTML and plain text without sending email", async () => {
  const captured: Array<{ html?: string; text?: string }> = [];
  const adapter = guestEmailAdapter(
    {
      send: (message) => {
        captured.push({
          html: "html" in message ? message.html : undefined,
          text: "text" in message ? message.text : undefined,
        });
        return Promise.resolve({ messageId: "captured" });
      },
    },
    "noreply@example.com"
  );
  const input = {
    artifactTitle: "<img src=x onerror=alert(1)>",
    expiresAt: "2026-10-28",
    inviterName: "A & B",
    role: "editor" as const,
    to: "guest@example.com",
    workspaceName: "Workspace",
  };
  await adapter.sendInvitation({
    ...input,
    url: "https://example.com/g/token",
  });
  await adapter.sendCode({
    ...input,
    code: "123456",
    codeExpiresAt: "2026-10-27",
  });
  expect(captured).toHaveLength(2);
  expect(captured[0]?.html).toContain("&lt;img");
  expect(captured[0]?.html).not.toContain("<img");
  expect(captured[0]?.text).toContain("https://example.com/g/token");
  expect(captured[1]?.text).toContain("123456");
});

test("guest-open metadata uses link-open privacy helpers", () => {
  const request = new Request("https://example.com/g/a/test", {
    headers: {
      "CF-Connecting-IP": "192.0.2.123",
      Referer: "https://source.example/path?token=secret",
      "User-Agent": "Browser",
    },
  });
  Object.defineProperty(request, "cf", {
    value: { asn: 1234, city: "Sydney", country: "AU" },
  });
  const meta = guestOpenMetadata(request);
  expect(meta.ipPrefix).toBe("192.0.2.0/24");
  expect(meta.referrerHost).toBe("source.example");
  expect(meta.country).toBe("AU");
  expect(meta.asn).toBe("1234");
  expect(JSON.stringify(meta)).not.toContain("secret");
});

test("an idle guest stream revalidates and cancels its live subscription", async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const reader = guestStream(source, () => Promise.resolve(false)).getReader();
  expect((await reader.read()).done).toBe(true);
  expect(cancelled).toBe(true);
}, 5000);
