import { afterEach, expect, test } from "bun:test";
import { startCapture } from "./capture.ts";

const previousNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator"
);
const previousContext = Object.getOwnPropertyDescriptor(
  globalThis,
  "AudioContext"
);
afterEach(() => {
  for (const [key, descriptor] of [
    ["navigator", previousNavigator],
    ["AudioContext", previousContext],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});
test("capture requests mono 16kHz chosen mic, forwards samples, levels and stops tracks", async () => {
  let stopped = 0;
  let closed = 0;
  let constraints: MediaStreamConstraints | undefined;
  const processor = {
    connect: () => undefined,
    disconnect: () => undefined,
    onaudioprocess: null as
      | ((event: {
          inputBuffer: { getChannelData: () => Float32Array };
        }) => void)
      | null,
  };
  const node = { connect: () => undefined, disconnect: () => undefined };
  class Context {
    destination = {};
    resume() {
      return Promise.resolve();
    }
    close() {
      closed += 1;
      return Promise.resolve();
    }
    createMediaStreamSource() {
      return node;
    }
    createAnalyser() {
      return {
        ...node,
        fftSize: 0,
        getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(0.1),
      };
    }
    createScriptProcessor() {
      return processor;
    }
    createGain() {
      return { ...node, gain: { value: 1 } };
    }
  }
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: Context,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        enumerateDevices: () =>
          Promise.resolve([
            { deviceId: "mic", kind: "audioinput" },
            { deviceId: "camera", kind: "videoinput" },
          ]),
        getUserMedia: (input: MediaStreamConstraints) => {
          constraints = input;
          return Promise.resolve({
            getTracks: () => [
              {
                stop: () => {
                  stopped += 1;
                },
              },
            ],
          });
        },
      },
    },
  });
  const samples: Float32Array[] = [];
  const levels: number[] = [];
  const capture = await startCapture(
    (value) => {
      samples.push(value);
    },
    (value) => {
      levels.push(value);
    },
    "mic"
  );
  expect(constraints).toEqual({
    audio: { channelCount: 1, deviceId: { exact: "mic" }, sampleRate: 16_000 },
  });
  processor.onaudioprocess?.({
    inputBuffer: { getChannelData: () => new Float32Array([0.2, 0.1]) },
  });
  expect(samples[0]?.length).toBe(2);
  expect(levels[0]).toBeCloseTo(0.5);
  expect(capture.devices).toHaveLength(1);
  capture.stop();
  expect(stopped).toBe(1);
  expect(closed).toBe(1);
  expect(processor.onaudioprocess).toBeNull();
});
test("capture releases microphone if AudioContext cannot start", async () => {
  let stopped = false;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () =>
          Promise.resolve({
            getTracks: () => [
              {
                stop: () => {
                  stopped = true;
                },
              },
            ],
          }),
      },
    },
  });
  class BrokenContext {
    constructor() {
      throw new Error("context failed");
    }
  }
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: BrokenContext,
  });
  await expect(
    startCapture(
      () => undefined,
      () => undefined,
      ""
    )
  ).rejects.toThrow("Microphone unavailable");
  expect(stopped).toBe(true);
});
