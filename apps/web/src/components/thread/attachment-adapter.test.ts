import { expect, test } from "bun:test";
import type { PendingAttachment } from "@assistant-ui/react";
import type { FileInfo } from "#/integrations/trpc/types.ts";
import {
  createAttachmentAdapter,
  libraryAttachment,
} from "./attachment-adapter.ts";

const info = (id: string): FileInfo => ({
  createdAt: "2026-10-26T00:00:00Z",
  id,
  mime: "text/plain",
  name: `${id}.txt`,
  runId: null,
  size: 3,
  source: "upload",
});

const collect = async (
  iterable: AsyncGenerator<PendingAttachment, void> | Promise<PendingAttachment>
): Promise<PendingAttachment[]> => {
  if (iterable instanceof Promise) {
    return [await iterable];
  }
  const out: PendingAttachment[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
};

test("add shows the upload running, then waits for send", async () => {
  const adapter = createAttachmentAdapter(() => Promise.resolve(info("f1")));
  const file = new File(["abc"], "a.txt", { type: "text/plain" });
  const steps = await collect(adapter.add({ file }));
  expect(steps.map((step) => step.status.type)).toEqual([
    "running",
    "requires-action",
  ]);
  expect(new Set(steps.map((step) => step.id)).size).toBe(1);
});

test("send carries the server file id in a file part", async () => {
  const adapter = createAttachmentAdapter(() => Promise.resolve(info("f1")));
  const file = new File(["abc"], "a.txt", { type: "text/plain" });
  const steps = await collect(adapter.add({ file }));
  const pending = steps.at(-1);
  if (pending === undefined) {
    throw new Error("no attachment");
  }
  const sent = await adapter.send(pending);
  expect(sent.status).toEqual({ type: "complete" });
  expect(sent.content).toEqual([
    { data: "f1", filename: "f1.txt", mimeType: "text/plain", type: "file" },
  ]);
});

test("send rejects an attachment whose upload failed or never ran", async () => {
  const adapter = createAttachmentAdapter(() =>
    Promise.reject(new Error("boom"))
  );
  const file = new File(["abc"], "a.txt", { type: "text/plain" });
  await expect(collect(adapter.add({ file }))).rejects.toThrow("boom");
  await expect(
    adapter.send({
      content: [],
      file,
      id: "missing",
      name: "a.txt",
      status: { reason: "composer-send", type: "requires-action" },
      type: "file",
    })
  ).rejects.toThrow("was not uploaded");
});

test("a library file is added complete, with its id in a file part", () => {
  const added = libraryAttachment(info("f2"));
  expect(added.id).toBe("f2");
  expect(added.content).toEqual([
    { data: "f2", filename: "f2.txt", mimeType: "text/plain", type: "file" },
  ]);
});
