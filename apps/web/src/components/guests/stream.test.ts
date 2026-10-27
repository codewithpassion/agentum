import { expect, test } from "bun:test";
import type { StreamFrame } from "@repo/protocol/stream";
import { GuestFrames } from "./stream";

test("guest SSE preserves split frames and ignores invalid contracts", () => {
  const frames = new GuestFrames();
  const received: StreamFrame[] = [];
  const receive = (frame: StreamFrame) => received.push(frame);
  frames.push('data: {"frame":"run","runId":"r","sta', receive);
  expect(received).toEqual([]);
  frames.push(
    'tus":"waiting"}\n\ndata: {"frame":"unknown"}\n\ndata: {"frame":"ping"}\n',
    receive
  );
  expect(received).toEqual([{ frame: "run", runId: "r", status: "waiting" }]);
  frames.push("\n", receive);
  expect(received.at(-1)).toEqual({ frame: "ping" });
});
