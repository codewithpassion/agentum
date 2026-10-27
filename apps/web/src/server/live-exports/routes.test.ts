/** biome-ignore-all lint/suspicious/useAwait: Async boundary fixtures retain production port signatures. */
/** biome-ignore-all lint/performance/noAwaitInLoops: Sequential lifecycle cases mutate isolated authority and resource fixtures. */
import { expect, test } from "bun:test";
import { ExportError } from "@repo/live-export";
import { principals } from "../../../../../packages/services/src/artifacts/test-harness";
import { exportRouteHarness } from "./fixture";

const attachment = /^attachment; filename="[^"/]+\.docx"$/;
test("member endpoint delivers binary attachments, MIME, safe filenames and visible warning metadata", async () => {
  const h = await exportRouteHarness();
  const response = await h.app.request(
    `${h.path}docx`,
    { headers: { Origin: "http://localhost" }, method: "POST" },
    h.env
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain(
    "wordprocessingml.document"
  );
  expect(response.headers.get("Content-Disposition")).toMatch(attachment);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("X-Export-Revision")).toBe("17");
  expect(
    JSON.parse(
      decodeURIComponent(response.headers.get("X-Export-Warnings") ?? "")
    ).length
  ).toBeGreaterThan(0);
  expect(new Uint8Array(await response.arrayBuffer()).subarray(0, 2)).toEqual(
    new Uint8Array([80, 75])
  );
});

test("endpoint refuses unauthenticated/run identities, cross-site requests and flood limit", async () => {
  const h = await exportRouteHarness();
  for (const principal of [null, principals.agentOne]) {
    h.setPrincipal(principal);
    expect(
      (
        await h.app.request(
          `${h.path}docx`,
          { headers: { Origin: "http://localhost" }, method: "POST" },
          h.env
        )
      ).status
    ).toBe(401);
  }
  h.setPrincipal(principals.owner);
  expect(
    (
      await h.app.request(
        `${h.path}docx`,
        {
          headers: {
            "Content-Type": "text/plain",
            Origin: "https://evil.example",
          },
          method: "POST",
        },
        h.env
      )
    ).status
  ).toBe(403);
  h.setAllowed(false);
  expect(
    (
      await h.app.request(
        `${h.path}docx`,
        { headers: { Origin: "http://localhost" }, method: "POST" },
        h.env
      )
    ).status
  ).toBe(429);
  expect(h.counts().calls).toBe(0);
});

test("endpoint maps wrong format, unavailable printer, timeout and current credential revocation without leaking internal errors", async () => {
  const h = await exportRouteHarness();
  expect(
    (
      await h.app.request(
        `${h.path}exe`,
        { headers: { Origin: "http://localhost" }, method: "POST" },
        h.env
      )
    ).status
  ).toBe(400);
  expect(
    (
      await h.app.request(
        `${h.path}pptx`,
        { headers: { Origin: "http://localhost" }, method: "POST" },
        h.env
      )
    ).status
  ).toBe(422);
  expect(
    (
      await h.app.request(
        `${h.path}pdf`,
        { headers: { Origin: "http://localhost" }, method: "POST" },
        h.env
      )
    ).status
  ).toBe(503);
  for (const [code, status] of [
    ["export_timeout", 504],
    ["export_access_ended", 403],
  ] as const) {
    h.composed.services.liveExports = {
      download: async () => {
        throw new ExportError(code);
      },
    };
    expect(
      (
        await h.app.request(
          `${h.path}pdf`,
          { headers: { Origin: "http://localhost" }, method: "POST" },
          h.env
        )
      ).status
    ).toBe(status);
  }
  h.composed.services.liveExports = {
    download: async () => {
      throw new Error("private infrastructure details");
    },
  };
  const response = await h.app.request(
    `${h.path}pdf`,
    { headers: { Origin: "http://localhost" }, method: "POST" },
    h.env
  );
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("private infrastructure");
});

test("the route replays the original credential during export and rejects a session that ends", async () => {
  const h = await exportRouteHarness();
  const original = h.service.download;
  h.composed.services.liveExports = {
    download: (principal, input, revalidate, signal) =>
      original(
        principal,
        input,
        async () => {
          h.setPrincipal(null);
          await revalidate?.();
        },
        signal
      ),
  };
  const response = await h.app.request(
    `${h.path}docx`,
    { headers: { Origin: "http://localhost" }, method: "POST" },
    h.env
  );
  expect(response.status).toBe(403);
  expect(h.counts().calls).toBe(0);
});
