import { expect, test } from "bun:test";
import { createSegmenter, encodeWav, polishOrRaw } from "./audio.ts";

test("WAV header and clamped PCM16", () => {
  const wav = encodeWav(new Float32Array([-2, -1, 0, 1, 2]));
  const v = new DataView(wav.buffer);
  expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
  expect(v.getUint32(24, true)).toBe(16_000);
  expect(v.getUint16(22, true)).toBe(1);
  expect(v.getUint16(34, true)).toBe(16);
  expect(v.getUint32(40, true)).toBe(10);
  expect([0, 1, 2, 3, 4].map((i) => v.getInt16(44 + i * 2, true))).toEqual([
    -32_768, -32_768, 0, 32_767, 32_767,
  ]);
});
test("segments at 700ms pause and 15 seconds, retaining all samples", () => {
  const s = createSegmenter();
  expect(s.push(new Float32Array(1600).fill(0.2))).toEqual([]);
  const pause = s.push(new Float32Array(11_200));
  expect(pause[0]?.length).toBe(12_800);
  expect(s.flush().length).toBe(0);
  const long = s.push(new Float32Array(256_000).fill(0.2));
  expect(long[0]?.length).toBe(240_000);
  expect(s.flush().length).toBe(16_000);
});
test("polish falls back on error, timeout and length ratio", async () => {
  const raw = "hello there";
  expect(await polishOrRaw(raw, async () => ({ text: "Hello there." }))).toBe(
    "Hello there."
  );
  expect(await polishOrRaw(raw, async () => ({ text: "x" }))).toBe(raw);
  expect(await polishOrRaw(raw, async () => ({ text: "x".repeat(30) }))).toBe(
    raw
  );
  expect(
    await polishOrRaw(raw, () => Promise.reject(new Error("provider")))
  ).toBe(raw);
  expect(await polishOrRaw(raw, () => new Promise(() => undefined), 5)).toBe(
    raw
  );
});
