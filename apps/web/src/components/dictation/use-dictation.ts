// biome-ignore-all lint/suspicious/noUnnecessaryConditions: React refs change in callbacks between renders; their initial values are not invariants.
import { type RefObject, useEffect, useRef, useState } from "react";
import { createSegmenter, polishOrRaw, wavBase64 } from "./audio.ts";
import { type Capture, type StartCapture, startCapture } from "./capture.ts";

export interface DictationAdapter {
  polish: (input: { text: string }) => Promise<{ text: string }>;
  status: () => Promise<{ available: boolean }>;
  transcribe: (input: {
    audio: string;
    final: boolean;
  }) => Promise<{ text: string }>;
}
export interface DictationOptions {
  adapter: DictationAdapter;
  capture?: StartCapture;
  disabled?: boolean;
  getValue: () => string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  setValue: (value: string) => void;
}
type Phase =
  | "idle"
  | "starting"
  | "listening"
  | "finishing"
  | "polishing"
  | "error";
interface Session {
  base: string;
  capture?: Capture;
  caret: number;
  end: number;
  final: string[];
  finishing: boolean;
  interim: string;
  requests: Promise<void>[];
  revision: number;
  segmenter: ReturnType<typeof createSegmenter>;
  timer?: ReturnType<typeof setInterval>;
}
const DEVICE_KEY = "dictation.microphone";
const storedDevice = () => {
  try {
    return localStorage.getItem(DEVICE_KEY) ?? "";
  } catch {
    return "";
  }
};
const resolveDevice = async (chosen: string) => {
  if (!chosen) {
    return "";
  }
  const listed = await navigator.mediaDevices.enumerateDevices();
  return listed.some(
    (device) => device.deviceId === chosen && device.kind === "audioinput"
  )
    ? chosen
    : "";
};
export function useDictation(options: DictationOptions) {
  const latest = useRef(options);
  latest.current = options;
  const [phase, setPhase] = useState<Phase>("idle");
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const [level, setLevel] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState(storedDevice);
  const selectedDevice = useRef(deviceId);
  const session = useRef<Session | null>(null);
  const held = useRef<{ at: number; active: boolean } | null>(null);
  const mounted = useRef(true);
  const busy = phase !== "idle" && phase !== "error";
  const paint = (s: Session) => {
    if (session.current === s) {
      setPreview([...s.final, s.interim].filter(Boolean).join(" "));
    }
  };
  const discard = () => {
    const s = session.current;
    session.current = null;
    held.current = null;
    if (s) {
      clearInterval(s.timer);
      s.capture?.stop();
      s.final = [];
      s.interim = "";
      s.segmenter.flush();
    }
    if (mounted.current) {
      setPreview("");
      setLevel(0);
      setPhase("idle");
    }
  };
  const fail = () => {
    discard();
    if (mounted.current) {
      setError(
        "Dictation failed. Check microphone permission, your audio input and the workspace provider key, then try again."
      );
      setPhase("error");
    }
  };
  const sendFinal = (s: Session, samples: Float32Array) => {
    s.revision += 1;
    if (!samples.length) {
      return;
    }
    const index = s.final.length;
    s.final.push(s.interim);
    s.interim = "";
    paint(s);
    const promise = latest.current.adapter
      .transcribe({ audio: wavBase64(samples), final: true })
      .then((result) => {
        if (session.current !== s) {
          return;
        }
        s.final[index] = result.text;
        paint(s);
      })
      .catch(() => {
        if (session.current === s) {
          fail();
        }
      });
    s.requests.push(promise);
  };
  const finish = async () => {
    const s = session.current;
    if (!s || s.finishing) {
      return;
    }
    s.finishing = true;
    clearInterval(s.timer);
    s.capture?.stop();
    s.capture = undefined;
    setPhase("finishing");
    setLevel(0);
    // A release during the permission prompt marks finishing; capture resolves and finishes below.
    if (!s.timer) {
      return;
    }
    sendFinal(s, s.segmenter.flush());
    await Promise.all(s.requests);
    if (session.current !== s) {
      return;
    }
    const raw = s.final.filter(Boolean).join(" ").trim();
    setPhase("polishing");
    setPreview(raw);
    const text = raw
      ? await polishOrRaw(raw, (value) =>
          latest.current.adapter.polish({ text: value })
        )
      : "";
    if (session.current !== s) {
      return;
    }
    if (text) {
      // Match normal textarea insertion: replace a selection verbatim, without adding spaces.
      latest.current.setValue(
        s.base.slice(0, s.caret) + text + s.base.slice(s.end)
      );
      const caret = s.caret + text.length;
      requestAnimationFrame(() => {
        const input = latest.current.inputRef.current;
        if (input) {
          input.focus();
          input.setSelectionRange(caret, caret);
        }
      });
    }
    discard();
  };
  const start = async () => {
    if (session.current || !available) {
      return;
    }
    const input = latest.current.inputRef.current;
    if (!input) {
      return;
    }
    const s: Session = {
      base: latest.current.getValue(),
      caret: input.selectionStart,
      end: input.selectionEnd,
      final: [],
      finishing: false,
      interim: "",
      requests: [],
      revision: 0,
      segmenter: createSegmenter(),
    };
    session.current = s;
    setPhase("starting");
    setError(null);
    setPreview("");
    try {
      const chosen = await resolveDevice(selectedDevice.current);
      if (chosen !== selectedDevice.current) {
        selectedDevice.current = chosen;
        setDeviceId(chosen);
      }
      if (session.current !== s) {
        return;
      }
      const capture = await (latest.current.capture ?? startCapture)(
        (samples) => {
          if (session.current !== s || s.finishing) {
            return;
          }
          for (const segment of s.segmenter.push(samples)) {
            sendFinal(s, segment);
          }
        },
        (value) => {
          if (session.current === s) {
            setLevel(value);
          }
        },
        chosen
      );
      if (session.current !== s) {
        capture.stop();
        return;
      }
      s.capture = capture;
      setDevices(capture.devices);
      let inFlight = false;
      s.timer = setInterval(() => {
        if (inFlight || s.finishing || session.current !== s) {
          return;
        }
        const samples = s.segmenter.snapshot();
        if (!samples.length) {
          return;
        }
        const { revision } = s;
        inFlight = true;
        latest.current.adapter
          .transcribe({ audio: wavBase64(samples), final: false })
          .then((result) => {
            if (
              session.current === s &&
              !s.finishing &&
              s.revision === revision
            ) {
              s.interim = result.text;
              paint(s);
            }
          })
          .catch(() => {
            // An interim belongs only to its open segment; finals and polishing supersede it.
            if (
              session.current === s &&
              !s.finishing &&
              s.revision === revision
            ) {
              fail();
            }
          })
          .finally(() => {
            inFlight = false;
          });
      }, 1000);
      if (s.finishing) {
        s.finishing = false;
        await finish();
      } else {
        setPhase("listening");
      }
    } catch {
      if (session.current === s) {
        fail();
      }
    }
  };
  const press = () => {
    if (held.current || latest.current.disabled || !available) {
      return;
    }
    const active = session.current !== null;
    if (active && session.current?.finishing) {
      return;
    }
    held.current = { active, at: Date.now() };
    if (!active) {
      start();
    }
  };
  const release = () => {
    const down = held.current;
    held.current = null;
    if (down && (down.active || Date.now() - down.at >= 250)) {
      finish();
    }
  };
  const actions = useRef({ discard, press, release });
  actions.current = { discard, press, release };
  useEffect(() => {
    mounted.current = true;
    let live = true;
    Promise.resolve()
      .then(() => latest.current.adapter.status())
      .then((result) => {
        if (live) {
          setAvailable(result.available);
        }
      })
      .catch(() => {
        if (live) {
          setAvailable(false);
        }
      });
    const enumerate = () =>
      navigator.mediaDevices
        ?.enumerateDevices()
        .then((list) => {
          if (live) {
            setDevices(list.filter((device) => device.kind === "audioinput"));
          }
        })
        .catch(() => undefined);
    enumerate();
    navigator.mediaDevices?.addEventListener?.("devicechange", enumerate);
    const down = (event: KeyboardEvent) => {
      if (event.key === "Escape" && session.current) {
        event.preventDefault();
        event.stopPropagation();
        actions.current.discard();
        return;
      }
      if (
        event.ctrlKey &&
        event.key.toLowerCase() === "d" &&
        document.activeElement === latest.current.inputRef.current
      ) {
        event.preventDefault();
        if (!event.repeat) {
          actions.current.press();
        }
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "d" && held.current) {
        event.preventDefault();
        actions.current.release();
      }
    };
    const blur = () => {
      if (held.current) {
        actions.current.release();
      }
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    return () => {
      live = false;
      mounted.current = false;
      actions.current.discard();
      navigator.mediaDevices?.removeEventListener?.("devicechange", enumerate);
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
    };
  }, []);
  useEffect(() => {
    if (options.disabled) {
      actions.current.discard();
    }
  }, [options.disabled]);
  const selectDevice = (id: string) => {
    selectedDevice.current = id;
    setDeviceId(id);
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch {
      /* Storage can be blocked; keep the choice for this mount. */
    }
  };
  return {
    available,
    base: session.current?.base ?? options.getValue(),
    busy,
    cancel: discard,
    caret: session.current?.caret ?? 0,
    deviceId,
    devices,
    disabled: options.disabled ?? false,
    end: session.current?.end ?? 0,
    error,
    inputRef: options.inputRef,
    level,
    phase,
    press,
    preview,
    release,
    selectDevice,
  };
}
export type Dictation = ReturnType<typeof useDictation>;
