import { expect, mock, test } from "bun:test";
import { CryptoHasher } from "bun";
import { capPayload, PAYLOAD_MAX_BYTES, payloadRefSchema } from "./payload.ts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

test("small payload passes through without storage", async () => {
  const payload = { value: 42 };
  const store = mock(async () => undefined);
  expect(await capPayload(payload, { key: "payloads/unused", store })).toEqual({
    payload,
    payload_ref: null,
  });
  expect(store).not.toHaveBeenCalled();
});

test("70 KB payload is stored once with byte count and SHA-256", async () => {
  const payload = { data: "x".repeat(70 * 1024) };
  const body = JSON.stringify(payload);
  const store = mock(async (_key: string, _body: string) => undefined);
  const result = payloadRefSchema.parse(
    (await capPayload(payload, { key: "payloads/large.json", store }))
      .payload_ref
  );
  expect(store).toHaveBeenCalledTimes(1);
  expect(store).toHaveBeenCalledWith("payloads/large.json", body);
  expect(result.key).toBe("payloads/large.json");
  expect(result.bytes).toBe(new TextEncoder().encode(body).byteLength);
  expect(result.sha256).toMatch(SHA256_PATTERN);
  expect(result.sha256).toBe(
    new CryptoHasher("sha256").update(body).digest("hex")
  );
});

test("exactly 65536 bytes stays inline; one byte more overflows", async () => {
  const overhead = JSON.stringify({ data: "" }).length;
  const payload = { data: "x".repeat(PAYLOAD_MAX_BYTES - overhead) };
  const store = mock(async () => undefined);
  expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBe(
    PAYLOAD_MAX_BYTES
  );
  expect(
    await capPayload(payload, { key: "payloads/boundary", store })
  ).toEqual({ payload, payload_ref: null });
  expect(store).not.toHaveBeenCalled();
  const result = payloadRefSchema.parse(
    (
      await capPayload(
        { data: `${payload.data}x` },
        { key: "payloads/boundary", store }
      )
    ).payload_ref
  );
  expect(result.bytes).toBe(PAYLOAD_MAX_BYTES + 1);
  expect(store).toHaveBeenCalledTimes(1);
});

test("cap measures UTF-8 bytes rather than characters", async () => {
  const payload = { data: "é".repeat(40_000) };
  expect(JSON.stringify(payload).length).toBeLessThan(PAYLOAD_MAX_BYTES);
  const result = payloadRefSchema.parse(
    (
      await capPayload(payload, {
        key: "payloads/unicode",
        store: async () => undefined,
      })
    ).payload_ref
  );
  expect(result.bytes).toBe(80_011);
});

test("storage failures propagate instead of returning an unavailable pointer", async () => {
  const store = mock(() => Promise.reject(new Error("storage failed")));
  await expect(
    capPayload({ data: "x".repeat(70_000) }, { key: "payloads/failure", store })
  ).rejects.toThrow("storage failed");
});

for (const kind of ["deep", "wide", "reserved", "cycle"]) {
  test(`capPayload safely rejects ${kind} payload`, async () => {
    const payload: Record<string, unknown> = {};
    if (kind === "deep") {
      let child = payload;
      for (let i = 0; i < 10_000; i += 1) {
        const next = {};
        child.next = next;
        child = next;
      }
    } else if (kind === "wide") {
      payload.values = Array.from({ length: 100_001 }, () => null);
    } else if (kind === "cycle") {
      payload.self = payload;
    } else {
      payload.nested = JSON.parse('{"__proto__": 1}');
    }
    await expect(
      capPayload(payload, {
        key: "payloads/test",
        store: async () => undefined,
      })
    ).rejects.toThrow("Payload");
  });
}

test("reference fields are bounded and validated", () => {
  const ref = { bytes: 0, key: "payloads/test", sha256: "a".repeat(64) };
  expect(payloadRefSchema.safeParse(ref).success).toBe(true);
  for (const changes of [
    { key: "other/test" },
    { key: `payloads/${"x".repeat(512)}` },
    { bytes: -1 },
    { bytes: 1.5 },
    { sha256: "A".repeat(64) },
  ]) {
    expect(payloadRefSchema.safeParse({ ...ref, ...changes }).success).toBe(
      false
    );
  }
});
