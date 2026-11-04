import { createResampler, SAMPLE_RATE } from "./audio.ts";
export interface Capture {
  devices: MediaDeviceInfo[];
  stop: () => void;
}
export type StartCapture = (
  onSamples: (samples: Float32Array) => void,
  onLevel: (level: number) => void,
  deviceId: string
) => Promise<Capture>;
export const startCapture: StartCapture = async (
  onSamples,
  onLevel,
  deviceId
) => {
  const constraints = {
    audio: {
      channelCount: 1,
      sampleRate: SAMPLE_RATE,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    if (
      !(
        deviceId &&
        error instanceof Error &&
        ["OverconstrainedError", "NotFoundError"].includes(error.name)
      )
    ) {
      throw error;
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: SAMPLE_RATE },
    });
  }
  let context: AudioContext | undefined;
  try {
    context = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (context.sampleRate !== SAMPLE_RATE) {
      await context.close();
      context = new AudioContext();
    }
    await context.resume();
    let source: MediaStreamAudioSourceNode;
    try {
      source = context.createMediaStreamSource(stream);
    } catch {
      // Firefox can reject a stream whose native rate differs from the requested context.
      await context.close();
      context = new AudioContext();
      await context.resume();
      source = context.createMediaStreamSource(stream);
    }
    const resample = createResampler(context.sampleRate);
    const analyser = context.createAnalyser();
    // ScriptProcessor remains the broadest portable capture fallback, with no worklet asset or bundler dependency.
    const processor = context.createScriptProcessor(2048, 1, 1);
    const mute = context.createGain();
    mute.gain.value = 0;
    const levels = new Float32Array(2048);
    analyser.fftSize = 2048;
    processor.onaudioprocess = (event) => {
      onSamples(resample(event.inputBuffer.getChannelData(0)));
      analyser.getFloatTimeDomainData(levels);
      onLevel(
        Math.min(
          1,
          Math.sqrt(levels.reduce((sum, s) => sum + s * s, 0) / levels.length) *
            5
        )
      );
    };
    source.connect(analyser);
    analyser.connect(processor);
    processor.connect(mute);
    mute.connect(context.destination);
    const devices = await navigator.mediaDevices.enumerateDevices();
    const active = context;
    return {
      devices: devices.filter((device) => device.kind === "audioinput"),
      stop: () => {
        processor.onaudioprocess = null;
        source.disconnect();
        analyser.disconnect();
        processor.disconnect();
        mute.disconnect();
        for (const track of stream.getTracks()) {
          track.stop();
        }
        active.close().catch(() => undefined);
      },
    };
  } catch {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    context?.close().catch(() => undefined);
    // biome-ignore lint/style/useErrorCause: Capture errors must not retain device details.
    throw new Error(
      "Microphone unavailable. Check permission and your audio input."
    );
  }
};
