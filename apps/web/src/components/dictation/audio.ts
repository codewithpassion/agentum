export const SAMPLE_RATE = 16_000;
// Weighted averaging keeps fractional frames across blocks (including 44.1kHz input).
export function createResampler(inputRate: number) {
  let weight = 0;
  let sum = 0;
  return (input: Float32Array): Float32Array => {
    if (inputRate === SAMPLE_RATE) {
      return new Float32Array(input);
    }
    const output: number[] = [];
    for (const sample of input) {
      let remaining = SAMPLE_RATE;
      while (remaining > 0) {
        const take = Math.min(remaining, inputRate - weight);
        sum += sample * take;
        weight += take;
        remaining -= take;
        if (weight === inputRate) {
          output.push(sum / inputRate);
          weight = 0;
          sum = 0;
        }
      }
    }
    return Float32Array.from(output);
  };
}
export function encodeWav(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  for (const [offset, text] of [
    [0, "RIFF"],
    [8, "WAVE"],
    [12, "fmt "],
    [36, "data"],
  ] as const) {
    [...text].forEach((char, index) => {
      v.setUint8(offset + index, char.charCodeAt(0));
    });
  }
  v.setUint32(4, bytes.length - 8, true);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => {
    const s = Math.max(-1, Math.min(1, sample));
    v.setInt16(44 + index * 2, s < 0 ? s * 32_768 : s * 32_767, true);
  });
  return bytes;
}
export const wavBase64 = (samples: Float32Array) => {
  const bytes = encodeWav(samples);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};
export function createSegmenter() {
  let samples: number[] = [];
  let quiet = 0;
  let speech = false;
  let voicedFrames = 0;
  let frameSamples = 0;
  let frameEnergy = 0;
  const flush = () => {
    const result = speech ? Float32Array.from(samples) : new Float32Array();
    samples = [];
    quiet = 0;
    speech = false;
    voicedFrames = 0;
    frameSamples = 0;
    frameEnergy = 0;
    return result;
  };
  return {
    flush,
    push: (block: Float32Array) => {
      const complete: Float32Array[] = [];
      for (const sample of block) {
        samples.push(sample);
        frameEnergy += sample * sample;
        frameSamples += 1;
        if (frameSamples < SAMPLE_RATE * 0.02) {
          continue;
        }
        if (Math.sqrt(frameEnergy / frameSamples) > 0.015) {
          quiet = 0;
          voicedFrames += 1;
          speech ||= voicedFrames >= 3;
        } else {
          quiet += frameSamples;
        }
        frameSamples = 0;
        frameEnergy = 0;
        if (
          samples.length >= SAMPLE_RATE * 15 ||
          (speech && quiet >= SAMPLE_RATE * 0.7)
        ) {
          const segment = flush();
          if (segment.length) {
            complete.push(segment);
          }
        }
      }
      return complete;
    },
    snapshot: () => (speech ? Float32Array.from(samples) : new Float32Array()),
  };
}
export async function polishOrRaw(
  raw: string,
  polish: (text: string) => Promise<{ text: string }>,
  timeout = 4000
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      polish(raw),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeout);
      }),
    ]);
    const text = result?.text.trim();
    return text &&
      text.length >= raw.length * 0.5 &&
      text.length <= raw.length * 1.5
      ? text
      : raw;
  } catch {
    return raw;
  } finally {
    clearTimeout(timer);
  }
}
