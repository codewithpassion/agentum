import { describe, expect, test } from "bun:test";
import { takeDesktopScreenshot } from "./desktop";
import type { RelayOutcome } from "./relay";

const failed = (
  reason: RelayOutcome["reason"],
  code: string | null = null,
  message = "nope"
): RelayOutcome => ({ code, message, ok: false, reason, result_json: null });

const fake = (outcome: RelayOutcome | Error) => {
  const sent: Record<string, unknown>[] = [];
  return {
    relay: {
      request: (message: Record<string, unknown>) => {
        sent.push(message);
        return outcome instanceof Error
          ? Promise.reject(outcome)
          : Promise.resolve(outcome);
      },
    },
    sent,
  };
};

describe("takeDesktopScreenshot", () => {
  test("sends a desktop_screenshot op with quality 60 and a deadline", async () => {
    const { relay, sent } = fake(failed("offline"));
    await takeDesktopScreenshot(relay);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      op: "desktop_screenshot",
      quality: 60,
      timeout_ms: 5000,
    });
    expect(typeof sent[0]?.id).toBe("string");
  });

  test("passes an explicit quality through", async () => {
    const { relay, sent } = fake(failed("offline"));
    await takeDesktopScreenshot(relay, 80);
    expect(sent[0]?.quality).toBe(80);
  });

  test("decodes the JPEG bytes and size", async () => {
    const { relay } = fake({
      code: null,
      message: "",
      ok: true,
      reason: null,
      result_json: JSON.stringify({
        data_b64: btoa("ÿØÿ"),
        height: 800,
        media_type: "image/jpeg",
        width: 1280,
      }),
    });
    const shot = await takeDesktopScreenshot(relay);
    expect(shot).toEqual({
      data: new Uint8Array([0xff, 0xd8, 0xff]),
      height: 800,
      mediaType: "image/jpeg",
      ok: true,
      width: 1280,
    });
  });

  test.each([
    [failed("client_error", "desktop_unavailable"), "desktop_unavailable"],
    [failed("client_error", "desktop_busy"), "desktop_busy"],
    [failed("client_error", "human_in_control"), "human_in_control"],
    [failed("client_error", "weird"), "error"],
    [failed("offline"), "offline"],
    [failed("stale"), "offline"],
    [failed("timeout"), "timeout"],
    [failed("revoked"), "revoked"],
  ] as const)("maps %j to %s", async (outcome, reason) => {
    const shot = await takeDesktopScreenshot(fake(outcome).relay);
    expect(shot).toMatchObject({ ok: false, reason });
  });

  test("reports a relay that throws as unreachable", async () => {
    const shot = await takeDesktopScreenshot(fake(new Error("boom")).relay);
    expect(shot).toEqual({ message: "boom", ok: false, reason: "unreachable" });
  });

  test("rejects a reply that is not a screenshot", async () => {
    const { relay } = fake({
      code: null,
      message: "",
      ok: true,
      reason: null,
      result_json: JSON.stringify({ ok: true }),
    });
    expect(await takeDesktopScreenshot(relay)).toMatchObject({
      ok: false,
      reason: "error",
    });
  });
});
