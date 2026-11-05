import { expect, test } from "bun:test";
import type { Database } from "@repo/db";
import type { EventsService } from "../events.ts";
import { type AppErrorTarget, createArtifactErrorsService } from "./errors.ts";

test("record stores the three ids of its target and no request details", async () => {
  const appended: unknown[] = [];
  const errors = createArtifactErrorsService({
    db: {} as Database,
    events: {
      append: (event: unknown) => {
        appended.push(event);
        return Promise.resolve();
      },
    } as unknown as EventsService,
    slot: () => Promise.resolve({ dropped: 0 }),
  });
  // Gateways pass the whole host props, which carry the visitor's details.
  const hostProps = {
    artifactId: "a",
    meta: {
      ipPrefix: "198.51.100.0/24",
      place: "AU",
      userAgent: "agent",
      visitorHash: "hash",
    },
    versionId: "v",
    viewer: { kind: "member", userId: "u" },
    workspaceId: "w",
  };
  await errors.record(
    hostProps as AppErrorTarget,
    "fetch page",
    new Error("boom")
  );
  expect(appended).toEqual([
    {
      actor: { id: "system", kind: "system" },
      payload: {
        artifactId: "a",
        dropped: 0,
        entry: "fetch page",
        message: "boom",
        versionId: "v",
        workspaceId: "w",
      },
      type: "app.error",
      workspaceId: "w",
    },
  ]);
});
