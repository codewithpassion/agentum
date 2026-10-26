import { expect, test } from "bun:test";
import { createMasker } from "@repo/protocol/masker";
import type { DeltaFrame } from "@repo/protocol/stream";
import { deltaPublisher, type LivePartial } from "./pi-run-deltas.ts";

const SECRET = "hunter2secret";
const TOKEN = `sk-${"abcdefghijklmnopqrst"}`;
const RUN_ID = "run-1";

interface Harness {
  advance: (ms: number) => void;
  frames: DeltaFrame[];
  offer: (live: LivePartial | undefined) => Promise<void>;
  setSecrets: (secrets: Record<string, string>) => void;
}

/** A publisher over a fake clock, collecting the frames it publishes. */
const harness = (secrets: Record<string, string> = {}): Harness => {
  let now = 0;
  let granted = secrets;
  const frames: DeltaFrame[] = [];
  const publisher = deltaPublisher({
    clock: () => now,
    maskerOf: () => Promise.resolve(createMasker(granted)),
    publish: (frame) => {
      frames.push(frame);
      return Promise.resolve();
    },
    runId: RUN_ID,
  });
  return {
    advance: (ms) => {
      now += ms;
    },
    frames,
    offer: publisher.offer,
    setSecrets: (next) => {
      granted = next;
    },
  };
};

const message = (
  content: readonly { type: string; text?: string }[],
  timestamp = 1000
): LivePartial => ({ generation: { message: { content, timestamp } } });

const text = (value: string) => ({ text: value, type: "text" });

test("a second offer within the gap sends nothing and one after it sends", async () => {
  const h = harness();
  await h.offer(message([text("one two three ")]));
  h.advance(100);
  await h.offer(message([text("one two three four ")]));
  expect(h.frames.length).toBe(1);

  h.advance(150);
  await h.offer(message([text("one two three four ")]));
  expect(h.frames.length).toBe(2);
  expect(h.frames[1]?.text).toBe("one two three four ");
});

test("each frame carries the full text so far", async () => {
  const h = harness();
  await h.offer(message([text("alpha beta ")]));
  h.advance(300);
  await h.offer(message([text("alpha beta gamma ")]));

  expect(h.frames.map((frame) => frame.text)).toEqual([
    "alpha beta ",
    "alpha beta gamma ",
  ]);
});

test("messageKey is stable for one message and changes with its timestamp", async () => {
  const h = harness();
  await h.offer(message([text("first ")], 1000));
  h.advance(300);
  await h.offer(message([text("first second ")], 1000));
  h.advance(300);
  await h.offer(message([text("next ")], 2000));

  expect(h.frames.map((frame) => frame.messageKey)).toEqual([
    `${RUN_ID}:1000`,
    `${RUN_ID}:1000`,
    `${RUN_ID}:2000`,
  ]);
  expect(h.frames.every((frame) => frame.frame === "delta")).toBe(true);
  expect(h.frames.every((frame) => frame.runId === RUN_ID)).toBe(true);
});

test("a granted secret is masked in a later frame, and its half never leaves", async () => {
  const h = harness({ API_TOKEN: SECRET });
  await h.offer(message([text("Use hunter2")]));
  h.advance(300);
  await h.offer(message([text(`Use ${SECRET} now `)]));

  expect(h.frames.length).toBe(2);
  expect(h.frames[0]?.text).toBe("Use ");
  expect(h.frames[1]?.text).toBe("Use [secret:API_TOKEN] now ");
  expect(h.frames.some((frame) => frame.text.includes("hunter2"))).toBe(false);
});

test("a whole sk- token in a later partial is redacted", async () => {
  const h = harness();
  await h.offer(message([text(`key is ${TOKEN} now and`)]));

  expect(h.frames.length).toBe(1);
  expect(h.frames[0]?.text).not.toContain(TOKEN);
  h.advance(300);
  await h.offer(message([text(`key is ${TOKEN} now and more `)]));

  expect(h.frames.length).toBe(2);
  expect(h.frames[1]?.text).not.toContain(TOKEN);
});

test("a message with only a toolCall block sends no frame", async () => {
  const h = harness();
  await h.offer(message([{ type: "toolCall" }]));
  expect(h.frames).toEqual([]);
});

test("text with a toolCall block sends only the text", async () => {
  const h = harness();
  await h.offer(message([text("Looking now "), { type: "toolCall" }]));
  expect(h.frames.map((frame) => frame.text)).toEqual(["Looking now "]);
});

test("thinking blocks are never sent", async () => {
  const h = harness();
  await h.offer(
    message([
      { text: "private reasoning here ", type: "thinking" },
      text("Answer text "),
    ])
  );
  expect(h.frames.map((frame) => frame.text)).toEqual(["Answer text "]);
});

test("unchanged text sends no repeat frame", async () => {
  const h = harness();
  await h.offer(message([text("same words here ")]));
  h.advance(300);
  await h.offer(message([text("same words here ")]));
  expect(h.frames.length).toBe(1);
});

test("a throwing publish does not reject offer", async () => {
  const publisher = deltaPublisher({
    clock: () => 0,
    maskerOf: () => Promise.resolve(null),
    publish: () => Promise.reject(new Error("stream down")),
    runId: RUN_ID,
  });
  await expect(
    publisher.offer(message([text("some words here ")]))
  ).resolves.toBeUndefined();
});

test("a throwing maskerOf publishes nothing and does not reject", async () => {
  const frames: DeltaFrame[] = [];
  const publisher = deltaPublisher({
    clock: () => 0,
    maskerOf: () => Promise.reject(new Error("no secrets")),
    publish: (frame) => {
      frames.push(frame);
      return Promise.resolve();
    },
    runId: RUN_ID,
  });
  await expect(
    publisher.offer(message([text("unmasked words here ")]))
  ).resolves.toBeUndefined();
  expect(frames).toEqual([]);
});

test("a secret with spaces and lines never leaves in part", async () => {
  const pem = "-----BEGIN KEY-----\nMIIEvQIBADANBg\n-----END KEY-----";
  const h = harness({ PEM: pem });
  await h.offer(message([text("Here it is: -----BEGIN KEY-----\nMIIEvQ")]));
  h.advance(300);
  await h.offer(message([text(`Here it is: ${pem}\nDone `)]));

  expect(h.frames.map((frame) => frame.text)).toEqual([
    "Here it is: ",
    "Here it is: [secret:PEM]\nDone ",
  ]);
});

test("an sk- token split across two partials is held, then redacted", async () => {
  const h = harness();
  await h.offer(message([text("key is sk-abcdef")]));
  h.advance(300);
  await h.offer(message([text(`key is ${TOKEN} ok `)]));

  expect(h.frames.length).toBe(2);
  expect(h.frames[0]?.text).toBe("key is ");
  expect(h.frames[1]?.text).not.toContain("sk-abc");
  expect(h.frames[1]?.text).toContain("ok");
});

test("a whole secret at the end of the text is masked, not cut", async () => {
  const pem = "-----BEGIN KEY-----\nMIIEvQIBADANBg\n-----END KEY-----";
  const h = harness({ PEM: pem, PHRASE: "pass word pass" });
  await h.offer(message([text(`Here: ${pem} ok`)]));
  h.advance(300);
  await h.offer(message([text(`Here: ${pem} and pass word pass ok`)]));

  expect(h.frames.map((frame) => frame.text)).toEqual([
    "Here: [secret:PEM] ",
    "Here: [secret:PEM] and [secret:PHRASE] ",
  ]);
});

test("a change that only moves the held end sends no repeat and keeps the window", async () => {
  const h = harness();
  await h.offer(message([text("one two thr")]));
  h.advance(10);
  await h.offer(message([text("one two three four")]));

  expect(h.frames.map((frame) => frame.text)).toEqual(["one two "]);
  h.advance(300);
  await h.offer(message([text("one two three four")]));
  expect(h.frames.at(-1)?.text).toBe("one two three ");
});
