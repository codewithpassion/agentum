import { expect, test } from "bun:test";
import {
  createResampler,
  createSegmenter,
  encodeWav,
  polishOrRaw,
} from "./audio.ts";

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

test("resampling preserves duration and continuity across capture blocks", () => {
  for (const rate of [44_100, 48_000]) {
    const input = Float32Array.from({ length: rate }, (_, i) => i / rate);
    const whole = createResampler(rate)(input);
    const resample = createResampler(rate);
    const chunks = [
      resample(input.slice(0, 2048)),
      resample(input.slice(2048)),
    ] as const;
    expect(whole.length).toBe(16_000);
    expect([...chunks[0], ...chunks[1]]).toEqual([...whole]);
    expect(whole[8000]).toBeCloseTo(0.5, 3);
  }
});
test("speech requires three 20ms RMS frames, rejecting spikes and short noise", () => {
  const s = createSegmenter();
  const spikes = new Float32Array(320 * 10);
  for (let i = 0; i < spikes.length; i += 320) {
    spikes[i] = 0.1;
  }
  s.push(spikes);
  expect(s.flush().length).toBe(0);
  s.push(new Float32Array(640).fill(0.2));
  expect(s.snapshot().length).toBe(0);
  expect(s.flush().length).toBe(0);
  s.push(new Float32Array(959).fill(0.2));
  expect(s.snapshot().length).toBe(0);
  s.push(new Float32Array([0.2]));
  expect(s.flush().length).toBe(960);
});
